package processes

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// startSSHServer 는 비밀번호로 접속해 명령을 이 컴퓨터의 sh 로 실행하는 테스트용 SSH 서버를 띄운다.
func startSSHServer(t *testing.T, password string) (host string, port int) {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, given []byte) (*ssh.Permissions, error) {
			if string(given) != password {
				return nil, errors.New("wrong password")
			}
			return nil, nil
		},
	}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(requests)
				for newChannel := range channels {
					channel, requests, err := newChannel.Accept()
					if err != nil {
						continue
					}
					go func() {
						defer channel.Close()
						for req := range requests {
							if req.Type != "exec" {
								req.Reply(false, nil)
								continue
							}
							var payload struct{ Command string }
							ssh.Unmarshal(req.Payload, &payload)
							req.Reply(true, nil)

							cmd := exec.Command("sh", "-c", payload.Command)
							cmd.Stdout, cmd.Stderr = channel, channel.Stderr()
							status := 0
							if err := cmd.Run(); err != nil {
								status = 1
								var exitErr *exec.ExitError
								if errors.As(err, &exitErr) {
									status = exitErr.ExitCode()
								}
							}
							channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(status)}))
							return
						}
					}()
				}
			}()
		}
	}()

	addr := listener.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port
}

func TestMonitorOverSSH(t *testing.T) {
	host, port := startSSHServer(t, "pw")
	dir := t.TempDir()

	// 이 테스트만 쓰는 고유한 명령줄로 실행되는 프로세스
	marker := fmt.Sprintf("%d", 30000+time.Now().UnixNano()%10000)
	script := filepath.Join(dir, "start.sh")
	logDir := filepath.Join(dir, "logs")
	os.MkdirAll(filepath.Join(logDir, "old"), 0o755)
	os.WriteFile(script, []byte("#!/bin/sh\nexec sleep "+marker+"\n"), 0o755)
	os.WriteFile(filepath.Join(logDir, "app.log"), []byte("line1\nline2\nline3\n"), 0o644)
	t.Cleanup(func() { exec.Command("pkill", "-f", "^sleep "+marker+"$").Run() })

	store := NewStore(filepath.Join(dir, "processes.json"))
	body, _ := json.Marshal(Config{
		Groups: []Group{{Slug: "uw", Name: "의왕"}},
		Servers: []Server{
			{ID: "local", Group: "uw", Host: host, Port: port, User: "ops", Password: "pw"},
			{ID: "wrong-pw", Group: "uw", Host: host, Port: port, User: "ops", Password: "nope"},
		},
		Processes: []Process{{ID: "app", Server: "local", Match: "^sleep " + marker + "$", LogDir: logDir, StartScript: script,
			AutoRestart: true, WatchName: "sleep", WatchArgs: marker}},
	})
	if _, err := store.Save(body); err != nil {
		t.Fatal(err)
	}
	monitor := NewMonitor(store, filepath.Join(dir, "known_hosts"))
	defer monitor.Close()
	ctx := context.Background()

	pids := func() []Instance {
		t.Helper()
		servers, err := monitor.GroupStatus(ctx, "uw")
		if err != nil {
			t.Fatal(err)
		}
		if servers[0].Error != "" {
			t.Fatalf("server error: %s", servers[0].Error)
		}
		return servers[0].Processes[0].Instances
	}
	waitFor := func(running bool) []Instance {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			monitor.Reset()
			if instances := pids(); (len(instances) > 0) == running {
				return instances
			}
		}
		t.Fatalf("process running=%v not reached", running)
		return nil
	}

	servers, err := monitor.GroupStatus(ctx, "all")
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 || servers[0].Error != "" || len(servers[0].Processes[0].Instances) != 0 || servers[1].Error == "" {
		t.Fatalf("initial status = %+v", servers)
	}
	if known, _ := os.ReadFile(filepath.Join(dir, "known_hosts")); !strings.Contains(string(known), "ssh-ed25519") {
		t.Errorf("host key not recorded: %q", known)
	}

	if _, err := monitor.GroupStatus(ctx, "nope"); !isStatus(err, http.StatusNotFound) {
		t.Errorf("unknown group: %v", err)
	}

	if message, err := monitor.Control(ctx, "app", "start"); err != nil {
		t.Fatalf("start: %v", err)
	} else {
		t.Log(message)
	}
	first := waitFor(true)

	if _, err := monitor.Control(ctx, "app", "start"); !isStatus(err, http.StatusConflict) {
		t.Errorf("second start: %v", err)
	}

	if output, err := monitor.Log(ctx, "app", "app.log", 2); err != nil || output != "line2\nline3\n" {
		t.Errorf("log = %q, %v", output, err)
	}
	if _, err := monitor.Log(ctx, "app", "../start.sh", 2); !isStatus(err, http.StatusBadRequest) {
		t.Errorf("log outside logDir: %v", err)
	}
	if list, err := monitor.Files(ctx, "app", ""); err != nil || len(list.Entries) != 2 ||
		list.Entries[0].Name != "old" || list.Entries[0].Type != "dir" || list.Entries[1].Name != "app.log" || list.Entries[1].Size != 18 {
		t.Errorf("files = %+v, %v", list, err)
	}
	if list, err := monitor.Files(ctx, "app", "old"); err != nil || len(list.Entries) != 0 {
		t.Errorf("empty dir = %+v, %v", list, err)
	}
	if _, err := monitor.Files(ctx, "app", "app.log"); err == nil {
		t.Error("listing a file should fail")
	}

	if _, err := monitor.Control(ctx, "app", "restart"); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if second := waitFor(true); second[0].PID == first[0].PID {
		t.Errorf("pid not changed after restart: %d", second[0].PID)
	}

	if _, err := monitor.Control(ctx, "app", "stop"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	waitFor(false)
	if message, err := monitor.Control(ctx, "app", "stop"); err != nil || message != "이미 중지되어 있습니다" {
		t.Errorf("second stop: %q, %v", message, err)
	}

	if _, err := monitor.Control(ctx, "app", "delete"); !isStatus(err, http.StatusNotFound) {
		t.Errorf("unknown action: %v", err)
	}

	// 자동 재시작: 화면에서 중지했으면 다시 시작하지 않는다.
	watch := func() *WatchStatus {
		t.Helper()
		monitor.Reset()
		servers, _ := monitor.GroupStatus(ctx, "uw")
		return servers[0].Processes[0].Watch
	}
	monitor.watchOnce(ctx)
	if w := watch(); w == nil || w.Healthy || !w.Paused || w.Restarts != 0 {
		t.Fatalf("paused watch = %+v", w)
	}

	// 화면에서 시작하면 다시 감시하고, 밖에서 죽은 프로세스는 재시작 대기(기본 30초)가 지난 뒤 다시 시작한다.
	if _, err := monitor.Control(ctx, "app", "start"); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitFor(true)
	exec.Command("pkill", "-f", "^sleep "+marker+"$").Run()
	waitFor(false)
	monitor.watchOnce(ctx)
	if w := watch(); w.Healthy || w.Paused || w.Restarts != 0 {
		t.Fatalf("restarted within restartDelay: %+v", w)
	}
	monitor.mu.Lock()
	monitor.watches["app"].lastAttempt = time.Now().Add(-defaultRestartDelay)
	monitor.mu.Unlock()
	monitor.watchOnce(ctx)
	waitFor(true)
	if w := watch(); !w.Healthy || w.Restarts != 1 || w.LastRestartAt == nil || w.LastError != "" {
		t.Fatalf("auto restart = %+v", w)
	}
}

func TestHostKeyChangeIsRejected(t *testing.T) {
	r := newRemote(filepath.Join(t.TempDir(), "known_hosts"))
	addr := &net.TCPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 22}
	newKey := func() ssh.PublicKey {
		public, _, _ := ed25519.GenerateKey(rand.Reader)
		key, _ := ssh.NewPublicKey(public)
		return key
	}

	first := newKey()
	if err := r.checkHostKey("10.0.0.1:22", addr, first); err != nil {
		t.Fatalf("first connect: %v", err)
	}
	if err := r.checkHostKey("10.0.0.1:22", addr, first); err != nil {
		t.Fatalf("same key: %v", err)
	}
	if err := r.checkHostKey("10.0.0.1:22", addr, newKey()); err == nil || !strings.Contains(err.Error(), "다릅니다") {
		t.Fatalf("changed key: %v", err)
	}
}

func isStatus(err error, status int) bool {
	var userErr *UserError
	return errors.As(err, &userErr) && userErr.Status == status
}
