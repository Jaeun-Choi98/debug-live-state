package processes

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
			{ID: "p1", Server: "s1", Match: "java", LogFiles: []string{"/var/log/app/*.log"}, IniFiles: []string{"/opt/app/conf/*.ini"}, StartScript: "/opt/app/start.sh",
				AutoRestart: true, WatchName: "java", WatchArgs: "-jar /opt/app/app.jar"},
			{ID: "p1", Server: "s9", Match: "(", LogFiles: []string{"/home/*"}, IniFiles: []string{"/opt/app/conf/*"}, StartScript: "start.sh; rm -rf /", WatchName: "/usr/bin/java"},
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
		"processes[1].id", "processes[1].server", "processes[1].match", "processes[1].logFiles", "processes[1].iniFiles", "processes[1].startScript",
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
		current, _ := store.Load()
		body, _ := json.Marshal(map[string]any{
			"version":   current.Version,
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

func TestLoadMigratesToFilePatterns(t *testing.T) {
	file := filepath.Join(t.TempDir(), "processes.json")
	os.WriteFile(file, []byte(`{"groups":[],"servers":[],"processes":[
		{"id":"a","server":"s","match":"x","logFile":"/var/log/app/app.log"},
		{"id":"b","server":"s","match":"x","logDir":"/data/logs","configDir":"/data/conf"},
		{"id":"c","server":"s","match":"x","logFiles":["/opt/c/logs/*.log"]}]}`), 0o600)
	c, err := NewStore(file).Load()
	if err != nil {
		t.Fatal(err)
	}
	got := fmt.Sprint(c.Processes[0].LogFiles, c.Processes[1].LogFiles, c.Processes[1].IniFiles, c.Processes[2].LogFiles)
	want := "[/var/log/app/app.log] [/data/logs/* /data/logs/*/*] [/data/conf/*.ini /data/conf/*/*.ini] [/opt/c/logs/*.log]"
	if got != want {
		t.Errorf("migrated = %s\nwant       %s", got, want)
	}
}

func TestCheckFilePattern(t *testing.T) {
	for _, ok := range []string{"/opt/app/logs/*.log", "/opt/app/logs/*", "/opt/app/logs/*/*.log", "/opt/app.log", "/home/user/app-?.log"} {
		if problem := checkFilePattern(ok, false); problem != "" {
			t.Errorf("%s: %s", ok, problem)
		}
	}
	for _, bad := range []string{"/home/*", "/*/app.log", "/opt/*/x.log", "/opt/app/**", "/opt/../etc/x.log", "opt/app/x.log", "/opt/app/x y.log", "/opt/app/$(id).log", "/opt/app/[ab].log", "/opt"} {
		if checkFilePattern(bad, false) == "" {
			t.Errorf("%s should be rejected", bad)
		}
	}
	if checkFilePattern("/opt/app/conf/*.ini", true) != "" || checkFilePattern("/opt/app/conf/*", true) == "" {
		t.Error("ini patterns must end with .ini")
	}
}

func TestParseLS(t *testing.T) {
	output := "-rw-r--r--  1 1000 1000 1234 Nov 19 11:15 /opt/app/logs/app 1.log\n" +
		"drwxr-xr-x@ 3 501  20     96 Nov 19 11:15 /opt/app/logs/2026-11-19\n" +
		"lrwxr-xr-x  1 0    0       7 Nov 19  2025 /opt/app/logs/current -> app.log\n" +
		"crw-rw-rw-  1 0    0    1, 3 Nov 19 11:15 /dev/null\n"
	entries := parseLS(output)
	want := []FileEntry{
		{Path: "/opt/app/logs/app 1.log", Type: "file", Size: 1234, Modified: "Nov 19 11:15"},
		{Path: "/opt/app/logs/2026-11-19", Type: "dir", Size: 96, Modified: "Nov 19 11:15"},
		{Path: "/opt/app/logs/current", Type: "link", Size: 7, Modified: "Nov 19  2025", Target: "app.log"},
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

func TestResolveFileOnlyMatchesPatterns(t *testing.T) {
	p := Process{LogFiles: []string{"/var/log/app/*.log", "/var/log/app/*/*.log"}, IniFiles: []string{"/opt/app/conf/*.ini"}}
	for _, ok := range []string{"/var/log/app/a.log", "/var/log/app/2026/a.log"} {
		if err := resolveFile(p, RootLog, ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"/var/log/app/a.txt", "/var/log/app/x/y/a.log", "/var/log/app/../secret.log", "/etc/passwd", "a.log", "/var/log/app/it's.log", "/var/log/app/a\nb.log", ""} {
		if err := resolveFile(p, RootLog, bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
	if err := resolveFile(p, RootINI, "/opt/app/conf/db.ini"); err != nil {
		t.Errorf("ini: %v", err)
	}
	if err := resolveFile(p, RootINI, "/var/log/app/a.log"); err == nil {
		t.Error("log file must not open as ini")
	}
	if err := resolveFile(Process{}, RootLog, "/var/log/app/a.log"); err == nil {
		t.Error("no patterns should be rejected")
	}
	if err := resolveFile(p, "etc", "/etc/passwd"); err == nil {
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

func TestSaveRejectsStaleVersion(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "processes.json"))
	body := func(version string) []byte {
		data, _ := json.Marshal(Config{
			Version:   version,
			Groups:    []Group{{Slug: "uw", Name: "의왕"}},
			Servers:   []Server{{ID: "s1", Group: "uw", Host: "10.0.0.1", User: "ops", Password: "pw"}},
			Processes: []Process{{ID: "a", Server: "s1", Match: "java", StartScript: "/opt/a/start.sh"}},
		})
		return data
	}
	first, err := store.Save(body(""))
	if err != nil {
		t.Fatal(err)
	}
	if loaded, _ := store.Load(); loaded.Version != first.Version || first.Version == "" {
		t.Fatalf("version = %q, loaded %q", first.Version, loaded.Version)
	}
	if data, _ := os.ReadFile(store.path); strings.Contains(string(data), "version") {
		t.Error("version written to file")
	}

	// 설정 창을 연 상태(first.Version)에서 감시 창이 먼저 저장하면, 설정 창 저장은 409 로 거부된다.
	watched, err := store.UpdateWatch("a", WatchUpdate{AutoRestart: true, WatchArgs: "a.jar"})
	if err != nil || watched.Version == first.Version {
		t.Fatalf("update watch: %v, version %q", err, watched.Version)
	}
	if _, err := store.Save(body(first.Version)); !isStatus(err, http.StatusConflict) {
		t.Errorf("stale save: %v", err)
	}
	if loaded, _ := store.Load(); !loaded.Processes[0].AutoRestart {
		t.Error("watch change was overwritten")
	}
	if _, err := store.Save(body(watched.Version)); err != nil {
		t.Errorf("save with latest version: %v", err)
	}
}

func TestEffectivePatterns(t *testing.T) {
	check := func(p Process, root string, want string, wantProblem bool) {
		t.Helper()
		got, problem := p.EffectivePatterns(root)
		if fmt.Sprint(got) != want || (problem != "") != wantProblem {
			t.Errorf("%+v %s = %v, %q; want %s (problem %v)", p, root, got, problem, want, wantProblem)
		}
	}
	app := Process{StartScript: "/opt/shelter/start.sh"}
	check(app, RootLog, "[/opt/shelter/*.log /opt/shelter/*/*.log /opt/shelter/*/*/*.log /opt/shelter/*/*/*/*.log /opt/shelter/*/*/*/*/*.log]", false)
	check(app, RootINI, "[/opt/shelter/*.ini /opt/shelter/*/*.ini /opt/shelter/*/*/*.ini]", false)

	// 적어 둔 패턴: 상대 경로는 시작 스크립트 폴더 기준, 절대 경로는 그대로
	app.LogFiles = []string{"logs/*.log", "/var/log/shelter/*.log"}
	check(app, RootLog, "[/opt/shelter/logs/*.log /var/log/shelter/*.log]", false)

	// 시작 스크립트가 없거나, 폴더가 너무 얕으면 자동으로 찾지 않는다.
	check(Process{}, RootLog, "[]", true)
	check(Process{StartScript: "/opt/start.sh"}, RootLog, "[]", true)
	check(Process{LogFiles: []string{"logs/*.log"}}, RootLog, "[]", true)
}

func TestValidateRelativePatterns(t *testing.T) {
	base := func(p Process) Config {
		p.ID, p.Server, p.Match = "p", "s", "x"
		return Config{
			Groups:    []Group{{Slug: "uw", Name: "의왕"}},
			Servers:   []Server{{ID: "s", Group: "uw", Host: "h", User: "u", Password: "pw"}},
			Processes: []Process{p},
		}
	}
	ok := base(Process{StartScript: "/opt/shelter/start.sh", LogFiles: []string{"logs/*.log"}, IniFiles: []string{"conf/*.ini"}})
	if err := ok.Validate(); err != nil {
		t.Errorf("relative patterns: %v", err)
	}
	for _, bad := range []Process{
		{LogFiles: []string{"logs/*.log"}},                                         // 시작 스크립트 없음
		{StartScript: "/opt/shelter/start.sh", LogFiles: []string{"../etc/*.log"}}, // 폴더 밖
		{StartScript: "/opt/start.sh", LogFiles: []string{"*.log"}},                // /opt/*.log: 너무 얕음
		{StartScript: "/opt/shelter/start.sh", IniFiles: []string{"conf/*"}},       // .ini 아님
	} {
		c := base(bad)
		if err := c.Validate(); err == nil {
			t.Errorf("%+v should be rejected", bad)
		}
	}
}
