package processes

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Config 는 화면의 ⚙ 설정에서 편집하는 설정 파일(processes.json)의 구조. 프론트의 src/config/types.ts 와 맞춘다.
//
//	그룹(groups) ─┬─ 서버(servers, group = 그룹 slug) ─┬─ 프로세스(processes, server = 서버 id)
type Config struct {
	PollIntervalMs int `json:"pollIntervalMs,omitempty"`
	// 자동 재시작 확인 주기(ms). 0 이면 10000
	WatchIntervalMs int `json:"watchIntervalMs,omitempty"`
	// 자동 · 화면에서 시작한 뒤 프로세스가 뜨기를 기다리는 시간(ms). 이 시간 안에는 다시 자동 시작하지 않는다. 0 이면 30000
	RestartDelayMs int `json:"restartDelayMs,omitempty"`
	// 조회 · 저장 전용. 설정 파일 내용의 sha256 으로, 파일에는 쓰지 않는다.
	// 저장할 때 화면이 읽었던 version 을 돌려보내고, 그 사이 파일이 바뀌었으면(감시 창 · 다른 사용자 · 직접 수정) 거부한다.
	Version   string    `json:"version,omitempty"`
	Groups    []Group   `json:"groups"`
	Servers   []Server  `json:"servers"`
	Processes []Process `json:"processes"`
}

type Group struct {
	// URL 경로 (/uw). 소문자 · 숫자 · '-' 만 쓴다.
	Slug string `json:"slug"`
	// 화면 표시 이름 (의왕)
	Name string `json:"name"`
}

type Server struct {
	ID    string `json:"id"`
	Group string `json:"group"`
	Label string `json:"label,omitempty"`
	Host  string `json:"host"`
	// 0 이면 22
	Port int    `json:"port,omitempty"`
	User string `json:"user"`
	// 쓰기 전용. 파일에만 저장하고 조회 API 에는 내려주지 않는다. 저장할 때 비워 두면 기존 비밀번호를 유지한다.
	Password string `json:"password,omitempty"`
	// 조회 전용. 비밀번호가 저장되어 있으면 true. (저장 요청에 들어와도 무시한다)
	HasPassword bool `json:"hasPassword,omitempty"`
}

type Process struct {
	ID     string `json:"id"`
	Server string `json:"server"`
	Label  string `json:"label,omitempty"`
	// ps 의 명령줄(args)에 대한 정규식. 일치하는 프로세스를 이 항목의 실행 인스턴스로 본다.
	Match string `json:"match"`
	// 로그 폴더의 절대 경로. 화면에서 이 폴더 아래의 파일 · 폴더를 둘러보고 파일을 tail 로 본다.
	LogDir string `json:"logDir,omitempty"`
	// 설정(INI) 폴더의 절대 경로. 화면에서 이 폴더 아래의 *.ini 파일을 열어 읽고 고친다.
	ConfigDir string `json:"configDir,omitempty"`
	// 시작 · 재시작 때 실행할 스크립트의 절대 경로 (인자 없이 실행)
	StartScript string `json:"startScript,omitempty"`

	// 자동 재시작. 켜 두면 감시 프로세스가 ps 에 없을 때 시작 스크립트를 실행한다. (watchdog.go 참고)
	// 아래 세 값은 모니터링 화면에서 프로세스별로 바꾼다. (Store.UpdateWatch)
	AutoRestart bool `json:"autoRestart,omitempty"`
	// 감시 프로세스의 실행 파일 이름. ps 명령줄 첫 단어의 파일 이름과 정확히 같아야 한다. (예: java, 비워 두면 문자열만 본다)
	WatchName string `json:"watchName,omitempty"`
	// 감시 프로세스의 명령줄에 들어 있어야 하는 문자열 (정규식 아님, 비워 두면 이름만 본다) (예: /opt/app/app.jar)
	// 이름 · 문자열 중 하나 이상 필요하고, 둘 다 적으면 한 프로세스가 둘 다 만족해야 한다.
	WatchArgs string `json:"watchArgs,omitempty"`
}

func (s Server) addr() string {
	port := s.Port
	if port == 0 {
		port = 22
	}
	return fmt.Sprintf("%s:%d", s.Host, port)
}

// 원격 명령에 그대로 들어가므로 따옴표 · 공백 · $ 같은 셸 특수문자를 허용하지 않는다.
var (
	slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	hostPattern = regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
	pathPattern = regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`)
	// 실행 파일 이름 (경로 · 공백 없이)
	watchNamePattern = regexp.MustCompile(`^[^/\s]+$`)
	// 화면 · 서버의 다른 경로와 겹치는 slug
	reservedSlugs = map[string]bool{"all": true, "api": true, "config": true, "static": true, "log-config": true}
)

// Validate 는 저장 전에 설정을 검사하고, 문제를 하나에서 멈추지 않고 모두 모아서 돌려준다.
// 에러는 "servers[2].host: ..." 형식이다. 프론트(src/config/schema.ts)도 같은 규칙으로 먼저 검사한다.
func (c *Config) Validate() error {
	var errs []error
	add := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if c.PollIntervalMs != 0 && c.PollIntervalMs < 1000 {
		add("pollIntervalMs: 1000 이상이어야 합니다")
	}
	if c.WatchIntervalMs != 0 && c.WatchIntervalMs < 1000 {
		add("watchIntervalMs: 1000 이상이어야 합니다")
	}
	if c.RestartDelayMs != 0 && c.RestartDelayMs < 1000 {
		add("restartDelayMs: 1000 이상이어야 합니다")
	}
	if c.Groups == nil || c.Servers == nil || c.Processes == nil {
		add("groups, servers, processes: 배열이 필요합니다")
	}

	slugs := map[string]bool{}
	for i, g := range c.Groups {
		at := fmt.Sprintf("groups[%d]", i)
		switch {
		case !slugPattern.MatchString(g.Slug):
			add("%s.slug: 영문 소문자 · 숫자 · '-' 로 써야 합니다", at)
		case reservedSlugs[g.Slug]:
			add("%s.slug: '%s' 는 쓸 수 없습니다", at, g.Slug)
		case slugs[g.Slug]:
			add("%s.slug: '%s' 가 중복됩니다", at, g.Slug)
		}
		slugs[g.Slug] = true
		if g.Name == "" {
			add("%s.name: 비어 있습니다", at)
		}
	}

	serverIDs := map[string]bool{}
	for i, s := range c.Servers {
		at := fmt.Sprintf("servers[%d]", i)
		switch {
		case s.ID == "":
			add("%s.id: 비어 있습니다", at)
		case serverIDs[s.ID]:
			add("%s.id: '%s' 가 중복됩니다", at, s.ID)
		}
		serverIDs[s.ID] = true
		if !slugs[s.Group] {
			add("%s.group: 등록된 그룹이 아닙니다", at)
		}
		if !hostPattern.MatchString(s.Host) {
			add("%s.host: 호스트 이름이나 IP 가 필요합니다", at)
		}
		if s.Port < 0 || s.Port > 65535 {
			add("%s.port: 1~65535 사이여야 합니다", at)
		}
		if s.User == "" {
			add("%s.user: 비어 있습니다", at)
		}
		if s.Password == "" {
			add("%s.password: 비어 있습니다", at)
		}
	}

	processIDs := map[string]bool{}
	for i, p := range c.Processes {
		at := fmt.Sprintf("processes[%d]", i)
		switch {
		case p.ID == "":
			add("%s.id: 비어 있습니다", at)
		case processIDs[p.ID]:
			add("%s.id: '%s' 가 중복됩니다", at, p.ID)
		}
		processIDs[p.ID] = true
		if !serverIDs[p.Server] {
			add("%s.server: 등록된 서버가 아닙니다", at)
		}
		if _, err := regexp.Compile(p.Match); p.Match == "" || err != nil {
			add("%s.match: 올바른 정규식이 필요합니다", at)
		}
		for field, value := range map[string]string{"logDir": p.LogDir, "configDir": p.ConfigDir, "startScript": p.StartScript} {
			// path.Clean 과 다르면 '..', '//' 등이 들어 있는 경로다.
			if value != "" && (!pathPattern.MatchString(value) || path.Clean(value) != value) {
				add("%s.%s: 영문 · 숫자 · . _ - / 로 된 절대 경로가 필요합니다", at, field)
			}
		}
		if p.WatchName != "" && !watchNamePattern.MatchString(p.WatchName) {
			add("%s.watchName: 경로 · 공백 없는 실행 파일 이름이 필요합니다 (예: java)", at)
		}
		if p.AutoRestart && p.WatchName == "" && p.WatchArgs == "" {
			add("%s.watchArgs: 자동 재시작에는 감시 이름이나 감시 문자열이 필요합니다", at)
		}
		if p.AutoRestart && p.StartScript == "" {
			add("%s.startScript: 자동 재시작에는 시작 스크립트가 필요합니다", at)
		}
	}
	return errors.Join(errs...)
}

// Store 는 설정 파일을 읽고 쓴다. 파일에 SSH 비밀번호가 들어 있으므로 0600 으로 저장한다.
// 파일을 직접 고쳐도 바로 반영되도록 매번 파일에서 읽는다.
type Store struct {
	mu   sync.Mutex
	path string
}

func NewStore(path string) *Store {
	return &Store{path: path}
}

// ErrInvalid 는 저장 요청 본문이 잘못된 경우의 에러. ( 400 으로 응답 )
var ErrInvalid = errors.New("invalid processes config")

// Load 는 비밀번호를 포함한 설정을 돌려준다. 파일이 없으면 빈 설정이다.
func (s *Store) Load() (*Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// load 는 s.mu 를 잡은 상태에서 호출한다.
func (s *Store) load() (*Config, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return &Config{Groups: []Group{}, Servers: []Server{}, Processes: []Process{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", s.path, err)
	}
	migrateLogFile(data, &c)
	c.Version = contentHash(string(data))
	return &c, nil
}

// migrateLogFile 은 예전 설정의 processes[].logFile(로그 파일 하나)을 그 파일이 있는 폴더(logDir)로 바꿔 읽는다.
// 다음에 저장하면 logDir 로 저장된다.
func migrateLogFile(data []byte, c *Config) {
	var legacy struct {
		Processes []struct {
			LogFile string `json:"logFile"`
		} `json:"processes"`
	}
	if json.Unmarshal(data, &legacy) != nil || len(legacy.Processes) != len(c.Processes) {
		return
	}
	for i, p := range legacy.Processes {
		if c.Processes[i].LogDir == "" && p.LogFile != "" {
			c.Processes[i].LogDir = path.Dir(p.LogFile)
		}
	}
}

// Public 은 화면에 내려줄 설정이다. 비밀번호를 지우고 저장 여부(hasPassword)만 알려준다.
func Public(c *Config) *Config {
	out := *c
	out.Servers = make([]Server, len(c.Servers))
	for i, server := range c.Servers {
		server.HasPassword = server.Password != ""
		server.Password = ""
		out.Servers[i] = server
	}
	return &out
}

// Save 는 body 를 검사한 뒤 저장하고, 저장한 설정(비밀번호 포함)을 돌려준다.
//
// 비밀번호를 비워 둔 서버는 기존 비밀번호를 유지한다. 단, 접속 대상(host · port · user)이 바뀌었으면 유지하지 않는다.
// (화면에 접근한 사람이 host 만 바꿔서 저장된 비밀번호를 다른 서버로 보내게 할 수 없도록)
func (s *Store) Save(body []byte) (*Config, error) {
	var next Config
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&next); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.load()
	if err != nil {
		return nil, err
	}
	// 설정 창을 연 뒤 다른 곳에서 설정이 바뀌었으면 덮어쓰지 않는다. (바뀐 내용이 사라지지 않도록)
	if next.Version != current.Version {
		return nil, &UserError{http.StatusConflict, "설정 창을 연 뒤 다른 곳(감시 창, 다른 사용자, 파일 직접 수정)에서 설정이 바뀌었습니다"}
	}
	saved := map[string]Server{}
	for _, server := range current.Servers {
		saved[server.ID] = server
	}
	for i, server := range next.Servers {
		old, ok := saved[server.ID]
		if server.Password == "" && ok && old.addr() == server.addr() && old.User == server.User {
			next.Servers[i].Password = old.Password
		}
		next.Servers[i].HasPassword = false
	}

	if err := next.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if err := s.write(&next); err != nil {
		return nil, err
	}
	return &next, nil
}

// WatchUpdate 는 모니터링 화면에서 바꾸는 프로세스 하나의 자동 재시작 설정이다.
type WatchUpdate struct {
	AutoRestart bool   `json:"autoRestart"`
	WatchName   string `json:"watchName"`
	WatchArgs   string `json:"watchArgs"`
}

// UpdateWatch 는 프로세스 하나의 자동 재시작 설정만 바꿔 저장하고, 저장한 설정(비밀번호 포함)을 돌려준다.
func (s *Store) UpdateWatch(processID string, update WatchUpdate) (*Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	config, err := s.load()
	if err != nil {
		return nil, err
	}
	index := -1
	for i, p := range config.Processes {
		if p.ID == processID {
			index = i
		}
	}
	if index < 0 {
		return nil, &UserError{http.StatusNotFound, fmt.Sprintf("'%s' 프로세스가 없습니다", processID)}
	}
	p := &config.Processes[index]
	p.AutoRestart, p.WatchName, p.WatchArgs = update.AutoRestart, strings.TrimSpace(update.WatchName), strings.TrimSpace(update.WatchArgs)

	// 이 프로세스의 문제만 "processes[3]." 을 떼고 알려준다. (다른 항목의 문제는 설정 화면에서 고칠 일이므로 막지 않는다)
	if err := config.Validate(); err != nil {
		prefix := fmt.Sprintf("processes[%d].", index)
		var mine []string
		for _, line := range strings.Split(err.Error(), "\n") {
			if strings.HasPrefix(line, prefix) {
				mine = append(mine, strings.TrimPrefix(line, prefix))
			}
		}
		if len(mine) > 0 {
			return nil, &UserError{http.StatusBadRequest, strings.Join(mine, "\n")}
		}
	}
	if err := s.write(config); err != nil {
		return nil, err
	}
	return config, nil
}

// write 는 s.mu 를 잡은 상태에서 호출한다. 저장한 뒤 c.Version 을 새 내용의 version 으로 바꾼다.
func (s *Store) write(c *Config) error {
	c.Version = ""
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := writeFileAtomic(s.path, data); err != nil {
		return err
	}
	c.Version = contentHash(string(data))
	return nil
}

// writeFileAtomic 은 쓰는 도중 실패해도 기존 파일이 깨지지 않도록 임시 파일(0600)에 쓴 뒤 바꿔치기한다.
func writeFileAtomic(target string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".processes-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // rename 에 성공하면 이미 없으므로 무시된다.

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}
