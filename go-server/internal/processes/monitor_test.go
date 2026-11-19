package processes

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
							cmd.Stdin, cmd.Stdout, cmd.Stderr = channel, channel, channel.Stderr()
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
	os.WriteFile(filepath.Join(logDir, "old", "app.log"), []byte("old\n"), 0o644)
	os.WriteFile(filepath.Join(logDir, "secret.txt"), []byte("x"), 0o644)
	os.WriteFile(script, []byte("#!/bin/sh\nexec sleep "+marker+"\n"), 0o755)
	os.WriteFile(filepath.Join(logDir, "app.log"), []byte("line1\nline2\nline3\n"), 0o644)
	configDir := filepath.Join(dir, "conf")
	os.MkdirAll(filepath.Join(configDir, "sub"), 0o755)
	os.WriteFile(filepath.Join(configDir, "app.ini"), []byte("[db]\r\nhost=a\r\n"), 0o640)
	os.WriteFile(filepath.Join(configDir, "notes.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(configDir, "euckr.ini"), []byte{0xb0, 0xa1, '\n'}, 0o644)
	t.Cleanup(func() { exec.Command("pkill", "-f", "^sleep "+marker+"$").Run() })

	store := NewStore(filepath.Join(dir, "processes.json"))
	body, _ := json.Marshal(Config{
		Groups: []Group{{Slug: "uw", Name: "의왕"}},
		Servers: []Server{
			{ID: "local", Group: "uw", Host: host, Port: port, User: "ops", Password: "pw"},
			{ID: "wrong-pw", Group: "uw", Host: host, Port: port, User: "ops", Password: "nope"},
		},
		Processes: []Process{{ID: "app", Server: "local", Match: "^sleep " + marker + "$", LogFiles: []string{logDir + "/*.log", logDir + "/*/*.log"}, IniFiles: []string{configDir + "/*.ini"}, StartScript: script,
			AutoRestart: true, WatchName: "sleep", WatchArgs: marker},
			// 패턴 없이 시작 스크립트만: 그 폴더(dir) 아래 *.log(5단계) · *.ini(3단계)를 찾는다.
			{ID: "auto", Server: "local", Match: "^never-matches$", StartScript: script}},
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

	appLog, appINI := logDir+"/app.log", configDir+"/app.ini"
	if output, err := monitor.Log(ctx, "app", appLog, 2); err != nil || output != "line2\nline3\n" {
		t.Errorf("log = %q, %v", output, err)
	}
	if _, err := monitor.Log(ctx, "app", logDir+"/secret.txt", 2); !isStatus(err, http.StatusBadRequest) {
		t.Errorf("log outside patterns: %v", err)
	}

	// 전체 내려받기: 크기를 먼저 알려주고 그만큼 보낸다. 패턴 밖 파일은 시작하기 전에 거부한다.
	var downloaded bytes.Buffer
	var announced int64 = -1
	err = monitor.DownloadLog(ctx, "app", appLog, func(size int64) io.Writer { announced = size; return &downloaded })
	if err != nil || announced != 18 || downloaded.String() != "line1\nline2\nline3\n" {
		t.Errorf("download = %q (size %d), %v", downloaded.String(), announced, err)
	}
	started := false
	if err := monitor.DownloadLog(ctx, "app", logDir+"/secret.txt", func(int64) io.Writer { started = true; return io.Discard }); !isStatus(err, http.StatusBadRequest) || started {
		t.Errorf("download outside patterns: %v, started %v", err, started)
	}
	if err := monitor.DownloadLog(ctx, "app", logDir+"/missing.log", func(int64) io.Writer { started = true; return io.Discard }); err == nil || started {
		t.Errorf("download missing file: %v, started %v", err, started)
	}
	// 패턴에 맞는 파일만 (폴더 old, secret.txt 는 빠진다)
	if list, err := monitor.Files(ctx, "app", RootLog); err != nil || len(list.Entries) != 2 {
		t.Errorf("files = %+v, %v", list, err)
	} else {
		paths := map[string]bool{list.Entries[0].Path: true, list.Entries[1].Path: true}
		if !paths[appLog] || !paths[logDir+"/old/app.log"] {
			t.Errorf("files = %+v", list.Entries)
		}
	}

	if list, err := monitor.Files(ctx, "auto", RootLog); err != nil || len(list.Entries) != 2 {
		t.Errorf("auto log files = %+v, %v", list, err)
	}
	if list, err := monitor.Files(ctx, "auto", RootINI); err != nil || len(list.Entries) != 2 {
		t.Errorf("auto ini files = %+v, %v", list, err)
	}
	if output, err := monitor.Log(ctx, "auto", appLog, 1); err != nil || output != "line3\n" {
		t.Errorf("auto log = %q, %v", output, err)
	}

	// INI: *.ini 만 보이고, 읽고 쓸 수 있다. (하위 폴더 sub 와 notes.txt 는 빠진다)
	if list, err := monitor.Files(ctx, "app", RootINI); err != nil || len(list.Entries) != 2 {
		t.Errorf("ini files = %+v, %v", list, err)
	}
	ini, err := monitor.ReadINI(ctx, "app", appINI)
	if err != nil || ini.Content != "[db]\r\nhost=a\r\n" {
		t.Fatalf("read ini = %+v, %v", ini, err)
	}
	if _, err := monitor.WriteINI(ctx, "app", appINI, "[db]\r\nhost=b\r\n", ini.Hash); err != nil {
		t.Fatalf("write ini: %v", err)
	}
	written, _ := os.ReadFile(filepath.Join(configDir, "app.ini"))
	backup, _ := os.ReadFile(filepath.Join(configDir, "app.ini.bak"))
	info, _ := os.Stat(filepath.Join(configDir, "app.ini"))
	if string(written) != "[db]\r\nhost=b\r\n" || string(backup) != "[db]\r\nhost=a\r\n" || info.Mode().Perm() != 0o640 {
		t.Errorf("written = %q, backup = %q, mode = %v", written, backup, info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(configDir, "app.ini.pm-new")); !os.IsNotExist(err) {
		t.Errorf("temp file left: %v", err)
	}
	if _, err := monitor.WriteINI(ctx, "app", appINI, "stale", ini.Hash); !isStatus(err, http.StatusConflict) {
		t.Errorf("stale write: %v", err)
	}
	if _, err := monitor.ReadINI(ctx, "app", configDir+"/euckr.ini"); !isStatus(err, http.StatusUnprocessableEntity) {
		t.Errorf("non-utf8: %v", err)
	}
	if _, err := monitor.ReadINI(ctx, "app", configDir+"/notes.txt"); !isStatus(err, http.StatusBadRequest) {
		t.Errorf("non-ini: %v", err)
	}
	if _, err := monitor.ReadINI(ctx, "app", configDir+"/../conf/app.ini"); !isStatus(err, http.StatusBadRequest) {
		t.Errorf("unclean path: %v", err)
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

	// 감시 조건 확인: 저장 전에 지금 맞는 프로세스를 본다.
	if found, err := monitor.WatchTest(ctx, "app", "", "sleep "+marker); err != nil || len(found) != 1 {
		t.Errorf("watch test = %+v, %v", found, err)
	}
	if found, err := monitor.WatchTest(ctx, "app", "java", marker); err != nil || len(found) != 0 {
		t.Errorf("watch test with wrong name = %+v, %v", found, err)
	}
	if _, err := monitor.WatchTest(ctx, "app", " ", ""); !isStatus(err, http.StatusBadRequest) {
		t.Errorf("empty watch test: %v", err)
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
