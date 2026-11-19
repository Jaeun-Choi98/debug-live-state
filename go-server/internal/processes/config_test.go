package processes

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateCollectsAllErrors(t *testing.T) {
	c := Config{
		PollIntervalMs: 10,
		Groups:         []Group{{Slug: "uw", Name: "의왕"}, {Slug: "all", Name: "x"}, {Slug: "UW", Name: ""}},
		Servers: []Server{
			{ID: "s1", Group: "uw", Host: "10.0.0.1", User: "ops", Password: "pw"},
			{ID: "s1", Group: "nope", Host: "bad host", Port: 70000, User: "", Password: ""},
		},
		Processes: []Process{
			{ID: "p1", Server: "s1", Match: "java", LogFile: "/var/log/app.log", StartScript: "/opt/app/start.sh"},
			{ID: "p1", Server: "s9", Match: "(", LogFile: "/var/log/../shadow", StartScript: "start.sh; rm -rf /"},
		},
	}
	err := c.Validate()
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{
		"pollIntervalMs", "groups[1].slug", "groups[2].slug", "groups[2].name",
		"servers[1].id", "servers[1].group", "servers[1].host", "servers[1].port", "servers[1].user", "servers[1].password",
		"processes[1].id", "processes[1].server", "processes[1].match", "processes[1].logFile", "processes[1].startScript",
	} {
		if !strings.Contains(err.Error(), want+":") {
			t.Errorf("missing error for %s\n%v", want, err)
		}
	}
	for _, unexpected := range []string{"groups[0]", "servers[0]", "processes[0]"} {
		if strings.Contains(err.Error(), unexpected) {
			t.Errorf("unexpected error for %s\n%v", unexpected, err)
		}
	}
}

func TestSaveKeepsPasswordOnlyForSameTarget(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "data", "processes.json"))
	save := func(server map[string]any) (*Config, error) {
		body, _ := json.Marshal(map[string]any{
			"groups":    []any{map[string]any{"slug": "uw", "name": "의왕"}},
			"servers":   []any{server},
			"processes": []any{},
		})
		return store.Save(body)
	}

	if _, err := save(map[string]any{"id": "s1", "group": "uw", "host": "10.0.0.1", "user": "ops", "password": "secret"}); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(store.path)
	if info.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %v, want 0600", info.Mode().Perm())
	}

	// 비밀번호를 비워도 같은 접속 대상이면 유지한다. (hasPassword 는 무시)
	saved, err := save(map[string]any{"id": "s1", "group": "uw", "label": "1호기", "host": "10.0.0.1", "port": 22, "user": "ops", "hasPassword": true})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Servers[0].Password != "secret" {
		t.Errorf("password not kept: %+v", saved.Servers[0])
	}
	if public := Public(saved); public.Servers[0].Password != "" || !public.Servers[0].HasPassword {
		t.Errorf("public view leaks password: %+v", public.Servers[0])
	}

	// host 가 바뀌면 비밀번호를 다시 입력해야 한다.
	if _, err := save(map[string]any{"id": "s1", "group": "uw", "host": "10.0.0.2", "user": "ops"}); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "servers[0].password") {
		t.Errorf("expected password error, got %v", err)
	}

	// 알 수 없는 필드는 거부한다.
	if _, err := save(map[string]any{"id": "s1", "group": "uw", "host": "10.0.0.1", "user": "ops", "command": "rm -rf /"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("expected unknown field error, got %v", err)
	}
}

func TestParsePS(t *testing.T) {
	rows := parsePS("    1  0.0  0.1 10-02:03:04 /sbin/init\n  4321 12.5  3.2    01:02 java -jar /opt/app/app.jar --port 80\n\n")
	if len(rows) != 2 {
		t.Fatalf("rows = %+v", rows)
	}
	want := Instance{PID: 4321, CPU: 12.5, Mem: 3.2, Elapsed: "01:02", Command: "java -jar /opt/app/app.jar --port 80"}
	if rows[1] != want {
		t.Errorf("got %+v, want %+v", rows[1], want)
	}
	// PID 1 과 상태 확인용 ps 는 제외한다.
	rows = append(rows, Instance{PID: 99, Command: psArgs + " java"})
	if got := matchInstances(Process{Match: "java|init"}, rows); len(got) != 1 || got[0].PID != 4321 {
		t.Errorf("matchInstances = %+v", got)
	}
}
