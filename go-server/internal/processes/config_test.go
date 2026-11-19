package processes

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateCollectsAllErrors(t *testing.T) {
	c := Config{
		PollIntervalMs: 10, WatchIntervalMs: 500, RestartDelayMs: -1,
		Groups: []Group{{Slug: "uw", Name: "의왕"}, {Slug: "all", Name: "x"}, {Slug: "UW", Name: ""}},
		Servers: []Server{
			{ID: "s1", Group: "uw", Host: "10.0.0.1", User: "ops", Password: "pw"},
			{ID: "s1", Group: "nope", Host: "bad host", Port: 70000, User: "", Password: ""},
		},
		Processes: []Process{
			{ID: "p1", Server: "s1", Match: "java", LogDir: "/var/log/app", StartScript: "/opt/app/start.sh",
				AutoRestart: true, WatchName: "java", WatchArgs: "-jar /opt/app/app.jar"},
			{ID: "p1", Server: "s9", Match: "(", LogDir: "/var/log/../shadow", StartScript: "start.sh; rm -rf /", WatchName: "/usr/bin/java"},
			{ID: "p3", Server: "s1", Match: "java", AutoRestart: true},
			{ID: "p4", Server: "s1", Match: "java", AutoRestart: true, WatchArgs: "/opt/app/app.jar", StartScript: "/opt/app/start.sh"},
		},
	}
	err := c.Validate()
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{
		"pollIntervalMs", "watchIntervalMs", "restartDelayMs", "groups[1].slug", "groups[2].slug", "groups[2].name",
		"servers[1].id", "servers[1].group", "servers[1].host", "servers[1].port", "servers[1].user", "servers[1].password",
		"processes[1].id", "processes[1].server", "processes[1].match", "processes[1].logDir", "processes[1].startScript",
		"processes[1].watchName", "processes[2].watchArgs", "processes[2].startScript",
	} {
		if !strings.Contains(err.Error(), want+":") {
			t.Errorf("missing error for %s\n%v", want, err)
		}
	}
	for _, unexpected := range []string{"groups[0]", "servers[0]", "processes[0]", "processes[3]"} {
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

func TestLoadMigratesLogFileToLogDir(t *testing.T) {
	file := filepath.Join(t.TempDir(), "processes.json")
	os.WriteFile(file, []byte(`{"groups":[],"servers":[],"processes":[
		{"id":"a","server":"s","match":"x","logFile":"/var/log/app/app.log"},
		{"id":"b","server":"s","match":"x","logDir":"/data/logs"}]}`), 0o600)
	c, err := NewStore(file).Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Processes[0].LogDir != "/var/log/app" || c.Processes[1].LogDir != "/data/logs" {
		t.Errorf("logDir = %q, %q", c.Processes[0].LogDir, c.Processes[1].LogDir)
	}
}

func TestParseLS(t *testing.T) {
	output := "total 16\n" +
		"drwxr-xr-x@ 3 501  20     96 Nov 19 11:15 2026-11-19\n" +
		"-rw-r--r--  1 1000 1000 1234 Nov 19 11:15 app 1.log\n" +
		"lrwxr-xr-x  1 0    0       7 Nov 19  2025 current -> app.log\n" +
		"crw-rw-rw-  1 0    0    1, 3 Nov 19 11:15 null\n"
	entries := parseLS(output)
	want := []FileEntry{
		{Name: "2026-11-19", Type: "dir", Size: 96, Modified: "Nov 19 11:15"},
		{Name: "app 1.log", Type: "file", Size: 1234, Modified: "Nov 19 11:15"},
		{Name: "current", Type: "link", Size: 7, Modified: "Nov 19  2025", Target: "app.log"},
	}
	if len(entries) != len(want) {
		t.Fatalf("entries = %+v", entries)
	}
	for i := range want {
		if entries[i] != want[i] {
			t.Errorf("entries[%d] = %+v, want %+v", i, entries[i], want[i])
		}
	}
}

func TestRootPathStaysInDir(t *testing.T) {
	p := Process{LogDir: "/var/log/app", ConfigDir: "/opt/app/conf"}
	if got, err := rootPath(p, RootLog, "2026/app.log"); err != nil || got != "/var/log/app/2026/app.log" {
		t.Errorf("rootPath = %q, %v", got, err)
	}
	if got, err := rootPath(p, RootINI, "db.ini"); err != nil || got != "/opt/app/conf/db.ini" {
		t.Errorf("rootPath = %q, %v", got, err)
	}
	for _, bad := range []string{"../etc/passwd", "a/../../b", "/etc/passwd", "a//b", "it's.log", "a\nb"} {
		if _, err := rootPath(p, RootLog, bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
	if _, err := rootPath(Process{}, RootLog, "a.log"); err == nil {
		t.Error("empty logDir should be rejected")
	}
	if _, err := rootPath(Process{LogDir: "/var/log"}, RootINI, ""); err == nil {
		t.Error("empty configDir should be rejected")
	}
	if _, err := rootPath(p, "etc", ""); err == nil {
		t.Error("unknown root should be rejected")
	}
}

func TestUpdateWatch(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "processes.json"))
	body, _ := json.Marshal(Config{
		Groups:    []Group{{Slug: "uw", Name: "의왕"}},
		Servers:   []Server{{ID: "s1", Group: "uw", Host: "10.0.0.1", User: "ops", Password: "secret"}},
		Processes: []Process{{ID: "a", Server: "s1", Match: "java", StartScript: "/opt/a/start.sh"}, {ID: "b", Server: "s1", Match: "x"}},
	})
	if _, err := store.Save(body); err != nil {
		t.Fatal(err)
	}

	saved, err := store.UpdateWatch("a", WatchUpdate{AutoRestart: true, WatchArgs: "  -jar /opt/a/a.jar "})
	if err != nil {
		t.Fatal(err)
	}
	if p := saved.Processes[0]; !p.AutoRestart || p.WatchArgs != "-jar /opt/a/a.jar" || saved.Servers[0].Password != "secret" {
		t.Errorf("saved = %+v / %+v", p, saved.Servers[0])
	}
	if loaded, _ := store.Load(); !loaded.Processes[0].AutoRestart {
		t.Error("not written to file")
	}

	// 시작 스크립트가 없는 프로세스는 자동 재시작을 켤 수 없고, 문제는 "processes[1]." 없이 알려준다.
	if _, err := store.UpdateWatch("b", WatchUpdate{AutoRestart: true, WatchName: "x"}); err == nil || !strings.HasPrefix(err.Error(), "startScript:") {
		t.Errorf("expected startScript error, got %v", err)
	}
	if _, err := store.UpdateWatch("a", WatchUpdate{AutoRestart: true}); err == nil || !strings.HasPrefix(err.Error(), "watchArgs:") {
		t.Errorf("expected watch condition error, got %v", err)
	}
	if _, err := store.UpdateWatch("zzz", WatchUpdate{}); err == nil {
		t.Error("unknown process should fail")
	}
}

func TestWatchTimingDefaults(t *testing.T) {
	var c Config
	if c.watchInterval() != defaultWatchInterval || c.restartDelay() != defaultRestartDelay {
		t.Errorf("defaults = %v, %v", c.watchInterval(), c.restartDelay())
	}
	c = Config{WatchIntervalMs: 5000, RestartDelayMs: 60000}
	if c.watchInterval() != 5*time.Second || c.restartDelay() != time.Minute {
		t.Errorf("custom = %v, %v", c.watchInterval(), c.restartDelay())
	}
}

func TestWatchInstances(t *testing.T) {
	rows := []Instance{
		{PID: 10, Command: "/usr/lib/jvm/bin/java -jar /opt/app/app.jar"},
		{PID: 11, Command: "vi /opt/app/app.jar.conf"},
		{PID: 12, Command: "java -jar /opt/other/other.jar"},
		{PID: 13, Command: "sh -c LC_ALL=C " + psArgs + " /opt/app/app.jar"},
	}
	pids := func(p Process) []int {
		var out []int
		for _, i := range watchInstances(p, rows) {
			out = append(out, i.PID)
		}
		return out
	}
	for _, c := range []struct {
		process Process
		want    []int
	}{
		{Process{WatchName: "java", WatchArgs: "/opt/app/app.jar"}, []int{10}},
		{Process{WatchName: "java"}, []int{10, 12}},
		{Process{WatchArgs: "/opt/app/app.jar"}, []int{10, 11}}, // 문자열만 쓰면 다른 프로그램도 맞을 수 있다
		{Process{}, nil},
	} {
		if got := pids(c.process); fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("%+v: got %v, want %v", c.process, got, c.want)
		}
	}
}
