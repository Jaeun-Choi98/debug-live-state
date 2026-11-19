package processes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const dialTimeout = 15 * time.Second

// remote 는 서버별 SSH 연결을 열어 두고 재사용하면서 명령을 실행한다.
// 연결은 접속 정보(user@host:port + 비밀번호)마다 하나이며, 끊겼으면 한 번 다시 연결한다.
type remote struct {
	mu      sync.Mutex
	clients map[string]*ssh.Client

	// 처음 접속하는 서버의 호스트 키를 기록해 두고, 다음부터 다르면 접속을 거부한다. (중간자 공격 방지)
	knownHostsPath string
	knownHostsMu   sync.Mutex
}

func newRemote(knownHostsPath string) *remote {
	return &remote{clients: map[string]*ssh.Client{}, knownHostsPath: knownHostsPath}
}

// run 은 server 에서 command 를 실행하고 표준 출력을 돌려준다.
// 종료 코드가 0 이 아니면 표준 에러 내용을 담은 에러를 돌려준다.
func (r *remote) run(ctx context.Context, server Server, command string) (string, error) {
	return r.runInput(ctx, server, command, nil)
}

// runInput 은 input 을 명령의 표준 입력으로 보낸다. (nil 이면 보내지 않는다)
func (r *remote) runInput(ctx context.Context, server Server, command string, input []byte) (string, error) {
	var stdout bytes.Buffer
	if err := r.exec(ctx, server, command, input, &stdout); err != nil {
		return "", err
	}
	return stdout.String(), nil
}

// stream 은 표준 출력을 메모리에 모으지 않고 w 로 바로 흘려보낸다. (큰 파일 내려받기)
// 실패하면 w 에 이미 일부가 써졌을 수 있다.
func (r *remote) stream(ctx context.Context, server Server, command string, w io.Writer) error {
	return r.exec(ctx, server, command, nil, w)
}

// exec 는 server 에서 command 를 실행하고 표준 출력을 stdout 에 쓴다.
// 종료 코드가 0 이 아니면 표준 에러 내용(없으면 표준 출력, 버퍼일 때만)을 담은 에러를 돌려준다.
func (r *remote) exec(ctx context.Context, server Server, command string, input []byte, stdout io.Writer) error {
	key := fmt.Sprintf("%s@%s|%x", server.User, server.addr(), sha256.Sum256([]byte(server.Password)))

	var session *ssh.Session
	for attempt := 0; ; attempt++ {
		client, err := r.client(key, server)
		if err != nil {
			return err
		}
		session, err = client.NewSession()
		if err == nil {
			break
		}
		// 서버 재시작 등으로 열어 둔 연결이 끊긴 경우: 버리고 한 번만 다시 연결한다.
		r.drop(key, client)
		if attempt > 0 {
			return fmt.Errorf("ssh session: %w", err)
		}
	}
	defer session.Close()

	var stderr bytes.Buffer
	session.Stdout = stdout
	session.Stderr = &stderr
	if input != nil {
		session.Stdin = bytes.NewReader(input)
	}

	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()

	select {
	case <-ctx.Done():
		// 세션을 닫아 Run 을 끝내고 기다린다. (돌아간 뒤에도 stdout 에 쓰는 일이 없도록)
		session.Close()
		<-done
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("명령이 시간 안에 끝나지 않았습니다: %w", ctx.Err())
		}
		return fmt.Errorf("명령이 취소되었습니다: %w", ctx.Err())
	case err := <-done:
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			detail := strings.TrimSpace(stderr.String())
			if buffered, ok := stdout.(*bytes.Buffer); ok && detail == "" {
				detail = strings.TrimSpace(buffered.String())
			}
			return fmt.Errorf("exit %d: %s", exitErr.ExitStatus(), detail)
		}
		return err
	}
}

// client 는 열어 둔 연결을 돌려주고, 없으면 새로 연결한다.
// 접속이 느린 서버가 다른 서버의 요청을 막지 않도록 연결하는 동안에는 잠그지 않는다.
func (r *remote) client(key string, server Server) (*ssh.Client, error) {
	r.mu.Lock()
	client := r.clients[key]
	r.mu.Unlock()
	if client != nil {
		return client, nil
	}

	password := server.Password
	client, err := ssh.Dial("tcp", server.addr(), &ssh.ClientConfig{
		User: server.User,
		Auth: []ssh.AuthMethod{
			ssh.Password(password),
			// PasswordAuthentication 대신 keyboard-interactive 로 비밀번호를 묻는 서버도 있다.
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = password
				}
				return answers, nil
			}),
		},
		HostKeyCallback: r.checkHostKey,
		Timeout:         dialTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("ssh %s@%s 접속 실패: %w", server.User, server.addr(), err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	// 동시에 연결한 다른 요청이 먼저 넣었으면 그것을 쓴다.
	if existing := r.clients[key]; existing != nil {
		client.Close()
		return existing, nil
	}
	r.clients[key] = client
	return client, nil
}

func (r *remote) drop(key string, client *ssh.Client) {
	r.mu.Lock()
	if r.clients[key] == client {
		delete(r.clients, key)
	}
	r.mu.Unlock()
	client.Close()
}

// closeAll 은 열어 둔 연결을 모두 닫는다. (설정 저장 · 서버 종료 시)
func (r *remote) closeAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, client := range r.clients {
		client.Close()
		delete(r.clients, key)
	}
}

// checkHostKey 는 known_hosts 파일로 호스트 키를 확인한다.
// 처음 보는 서버는 키를 기록하고 접속하며(TOFU), 기록과 다르면 거부한다.
func (r *remote) checkHostKey(hostname string, remoteAddr net.Addr, key ssh.PublicKey) error {
	r.knownHostsMu.Lock()
	defer r.knownHostsMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(r.knownHostsPath), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(r.knownHostsPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()

	check, err := knownhosts.New(r.knownHostsPath)
	if err != nil {
		return err
	}
	err = check(hostname, remoteAddr, key)

	var keyErr *knownhosts.KeyError
	switch {
	case errors.As(err, &keyErr) && len(keyErr.Want) == 0:
		_, err = fmt.Fprintln(file, knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key))
		return err
	case errors.As(err, &keyErr):
		return fmt.Errorf("%s 의 호스트 키가 %s 에 기록된 것과 다릅니다. 서버를 다시 설치한 것이 맞다면 해당 줄을 지우세요", hostname, r.knownHostsPath)
	default:
		return err
	}
}
