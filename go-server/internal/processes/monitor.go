package processes

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// 여러 사람이 같은 화면을 보고 있어도 서버마다 ps 는 이 간격에 한 번만 실행한다.
	psCacheTTL     = 2 * time.Second
	commandTimeout = 10 * time.Second
	// 중지(kill) 후 프로세스가 사라지기를 기다리는 최대 시간
	stopWaitTimeout = 10 * time.Second
	maxLogLines     = 2000
	// 로그 폴더 목록에 보여줄 최대 항목 수 (최근 수정 순)
	maxLogEntries = 1000
	// 실행 중인 프로세스 목록. 서버에서 실행하는 명령은 이것과 tail, kill, 시작 스크립트뿐이다.
	psArgs    = "ps -eo pid=,pcpu=,pmem=,etime=,args="
	psCommand = "LC_ALL=C " + psArgs
)

// UserError 는 화면에 그대로 보여줄 요청 오류. Status 는 HTTP 상태 코드.
type UserError struct {
	Status  int
	Message string
}

func (e *UserError) Error() string { return e.Message }

type Instance struct {
	PID int     `json:"pid"`
	CPU float64 `json:"cpu"`
	Mem float64 `json:"mem"`
	// 실행 시간 ([[dd-]hh:]mm:ss)
	Elapsed string `json:"elapsed"`
	Command string `json:"command"`
}

type ProcessStatus struct {
	ID string `json:"id"`
	// 비어 있으면 실행 중이 아니다.
	Instances []Instance `json:"instances"`
	// 감시 프로세스(watchName)를 등록한 경우에만 들어간다.
	Watch *WatchStatus `json:"watch,omitempty"`
}

type ServerStatus struct {
	ID string `json:"id"`
	// SSH 접속 · ps 실행에 실패한 이유. 이때 Processes 는 비어 있다.
	Error     string          `json:"error,omitempty"`
	CheckedAt time.Time       `json:"checkedAt"`
	Processes []ProcessStatus `json:"processes"`
}

type psSnapshot struct {
	at   time.Time
	rows []Instance
	err  error
}

// Monitor 는 설정에 등록한 서버에 SSH 로 접속해 프로세스 상태 · 로그를 확인하고 시작 · 중지한다.
type Monitor struct {
	store  *Store
	remote *remote

	mu sync.Mutex
	// 서버 id → 마지막 ps 결과
	snapshots map[string]psSnapshot
	// 서버 id 별 잠금. 같은 서버의 ps 를 동시에 여러 번 실행하지 않는다.
	serverLocks map[string]*sync.Mutex
	// 시작 · 중지가 진행 중인 프로세스 id
	busy map[string]bool
	// 프로세스 id → 자동 재시작 상태 (Go 서버 메모리에만 있다)
	watches map[string]*watchState
	// 자동 재시작 감시를 멈춘다. (StartWatchdog 전에는 nil)
	stopWatchdog context.CancelFunc
}

func NewMonitor(store *Store, knownHostsPath string) *Monitor {
	return &Monitor{
		store:       store,
		remote:      newRemote(knownHostsPath),
		snapshots:   map[string]psSnapshot{},
		serverLocks: map[string]*sync.Mutex{},
		busy:        map[string]bool{},
		watches:     map[string]*watchState{},
	}
}

// Reset 은 설정이 바뀌었을 때 열어 둔 SSH 연결과 캐시를 버린다.
func (m *Monitor) Reset() {
	m.remote.closeAll()
	m.mu.Lock()
	m.snapshots = map[string]psSnapshot{}
	m.mu.Unlock()
}

func (m *Monitor) Close() {
	if m.stopWatchdog != nil {
		m.stopWatchdog()
	}
	m.remote.closeAll()
}

// GroupStatus 는 그룹(slug, "all" 이면 전체)에 속한 서버들의 프로세스 상태를 서버마다 동시에 확인한다.
// 접속에 실패한 서버는 Error 에 이유를 담고, 나머지 서버의 결과는 그대로 돌려준다.
func (m *Monitor) GroupStatus(ctx context.Context, slug string) ([]ServerStatus, error) {
	config, err := m.store.Load()
	if err != nil {
		return nil, err
	}

	found := slug == "all"
	for _, g := range config.Groups {
		found = found || g.Slug == slug
	}
	if !found {
		return nil, &UserError{http.StatusNotFound, fmt.Sprintf("'%s' 그룹이 없습니다", slug)}
	}

	var servers []Server
	for _, s := range config.Servers {
		if slug == "all" || s.Group == slug {
			servers = append(servers, s)
		}
	}

	result := make([]ServerStatus, len(servers))
	var wg sync.WaitGroup
	for i, server := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			snapshot := m.ps(ctx, server, false)
			status := ServerStatus{ID: server.ID, CheckedAt: snapshot.at, Processes: []ProcessStatus{}}
			if snapshot.err != nil {
				status.Error = snapshot.err.Error()
			} else {
				for _, p := range config.Processes {
					if p.Server == server.ID {
						status.Processes = append(status.Processes, ProcessStatus{
							ID:        p.ID,
							Instances: matchInstances(p, snapshot.rows),
							Watch:     m.watchStatus(p, snapshot.rows),
						})
					}
				}
			}
			result[i] = status
		}()
	}
	wg.Wait()
	return result, nil
}

type FileEntry struct {
	Name string `json:"name"`
	// dir · file · link · other
	Type string `json:"type"`
	Size int64  `json:"size"`
	// ls 가 보여주는 수정 시각 그대로 ("Nov 19 11:15", 오래된 파일은 "Nov 19  2025")
	Modified string `json:"modified"`
	// 심볼릭 링크가 가리키는 경로
	Target string `json:"target,omitempty"`
}

type FileList struct {
	// 로그 폴더 기준 상대 경로 ("" 이면 로그 폴더)
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
	// maxLogEntries 개를 넘어서 오래된 항목을 잘랐는지
	Truncated bool `json:"truncated,omitempty"`
}

// Files 는 프로세스 로그 폴더 아래 rel 폴더의 파일 · 폴더 목록을 최근 수정 순으로 돌려준다. (폴더가 먼저)
func (m *Monitor) Files(ctx context.Context, processID, rel string) (*FileList, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return nil, err
	}
	dir, err := logPath(process, rel)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	// cd 로 폴더인지 · 들어갈 수 있는지 먼저 확인한다. (파이프 뒤의 head 때문에 ls 의 실패는 알 수 없으므로)
	command := fmt.Sprintf("cd -- '%s' || exit 1; [ -r . ] || { echo '읽기 권한이 없습니다' >&2; exit 1; }; LC_ALL=C ls -lAnt | head -n %d", dir, maxLogEntries+2)
	output, err := m.remote.run(ctx, server, command)
	if err != nil {
		return nil, err
	}
	entries := parseLS(output)
	list := &FileList{Path: rel, Entries: entries}
	if len(entries) > maxLogEntries {
		list.Entries, list.Truncated = entries[:maxLogEntries], true
	}
	return list, nil
}

// Log 는 프로세스 로그 폴더 아래 rel 파일의 마지막 lines 줄을 돌려준다.
func (m *Monitor) Log(ctx context.Context, processID, rel string, lines int) (string, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return "", err
	}
	if rel == "" {
		return "", &UserError{http.StatusBadRequest, "파일을 골라야 합니다"}
	}
	file, err := logPath(process, rel)
	if err != nil {
		return "", err
	}
	lines = max(1, min(lines, maxLogLines))

	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return m.remote.run(ctx, server, fmt.Sprintf("tail -n %d -- '%s'", lines, file))
}

// logPath 는 로그 폴더 아래의 상대 경로를 절대 경로로 바꾼다. 로그 폴더 밖으로 나가는 경로('..')는 거부한다.
// 결과는 작은따옴표로 감싸 명령에 넣으므로 작은따옴표와 제어 문자도 거부한다.
// (로그 폴더 안의 심볼릭 링크가 가리키는 곳까지 막지는 않는다)
func logPath(process Process, rel string) (string, error) {
	if process.LogDir == "" {
		return "", &UserError{http.StatusBadRequest, "로그 폴더가 등록되지 않았습니다"}
	}
	if rel == "" {
		return process.LogDir, nil
	}
	invalid := &UserError{http.StatusBadRequest, fmt.Sprintf("열 수 없는 경로입니다: %s", rel)}
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", invalid
		}
	}
	for _, r := range rel {
		if r == '\'' || r < 0x20 || r == 0x7f {
			return "", invalid
		}
	}
	return process.LogDir + "/" + rel, nil
}

// Control 은 프로세스를 시작(start) · 중지(stop) · 재시작(restart) 하고 결과 문구를 돌려준다.
//   - 중지: ps 로 찾은 PID 에 SIGTERM 을 보내고, 사라질 때까지 최대 10초 기다린다.
//   - 시작: 등록한 시작 스크립트를 스크립트가 있는 폴더에서 nohup 으로 실행한다.
func (m *Monitor) Control(ctx context.Context, processID, action string) (string, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return "", err
	}
	if action != "start" && action != "stop" && action != "restart" {
		return "", &UserError{http.StatusNotFound, fmt.Sprintf("알 수 없는 동작입니다: %s", action)}
	}
	if action != "stop" && process.StartScript == "" {
		return "", &UserError{http.StatusBadRequest, "시작 스크립트가 등록되지 않았습니다"}
	}

	m.mu.Lock()
	if m.busy[processID] {
		m.mu.Unlock()
		return "", &UserError{http.StatusConflict, "이 프로세스에 다른 작업이 진행 중입니다"}
	}
	m.busy[processID] = true
	// 화면에서 중지하면 다시 시작할 때까지 자동 재시작을 멈춘다. (중지하자마자 감시가 다시 켜지 않도록 먼저 표시)
	// 시작 · 재시작하면 다시 켜고, 프로세스가 뜰 때까지 재시작 대기(restartDelayMs) 동안은 감시가 따로 시작하지 않게 한다.
	if state := m.watch(processID); action == "stop" {
		state.paused = true
	} else {
		state.paused, state.lastAttempt = false, time.Now()
	}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.busy, processID)
		m.mu.Unlock()
	}()

	running := func() ([]Instance, error) {
		snapshot := m.ps(ctx, server, true)
		return matchInstances(process, snapshot.rows), snapshot.err
	}
	instances, err := running()
	if err != nil {
		return "", err
	}

	if action == "start" && len(instances) > 0 {
		return "", &UserError{http.StatusConflict, fmt.Sprintf("이미 실행 중입니다 (PID %s)", pidList(instances))}
	}

	var messages []string
	if action != "start" && len(instances) > 0 {
		stopCtx, cancel := context.WithTimeout(ctx, commandTimeout)
		_, err := m.remote.run(stopCtx, server, "kill -TERM "+pidList(instances))
		cancel()
		if err != nil {
			return "", fmt.Errorf("중지하지 못했습니다: %w", err)
		}
		for deadline := time.Now().Add(stopWaitTimeout); len(instances) > 0; {
			if time.Now().After(deadline) {
				return "", fmt.Errorf("%s 안에 종료되지 않았습니다 (PID %s)", stopWaitTimeout, pidList(instances))
			}
			time.Sleep(500 * time.Millisecond)
			if instances, err = running(); err != nil {
				return "", err
			}
		}
		messages = append(messages, "중지했습니다")
	} else if action == "stop" {
		return "이미 중지되어 있습니다", nil
	}

	if action != "stop" {
		if err := m.runStart(ctx, server, process); err != nil {
			return "", err
		}
		messages = append(messages, "시작 명령을 보냈습니다")
	}
	return strings.Join(messages, " · "), nil
}

// runStart 는 시작 스크립트를 스크립트가 있는 폴더에서 백그라운드로 실행한다. (끝나기를 기다리지 않는다)
func (m *Monitor) runStart(ctx context.Context, server Server, process Process) error {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	// "cd && nohup ... &" 로 쓰면 cd 까지 묶인 서브셸이 백그라운드로 남아 SSH 출력을 붙잡으므로 세션이 끝나지 않는다.
	command := fmt.Sprintf("cd '%s' || exit 1; nohup '%s' > /dev/null 2>&1 < /dev/null &", path.Dir(process.StartScript), process.StartScript)
	_, err := m.remote.run(ctx, server, command)

	m.mu.Lock()
	delete(m.snapshots, server.ID) // 다음 상태 조회에서 바로 바뀐 결과가 보이도록
	m.mu.Unlock()
	if err != nil {
		return fmt.Errorf("시작하지 못했습니다: %w", err)
	}
	return nil
}

func (m *Monitor) find(processID string) (Process, Server, error) {
	config, err := m.store.Load()
	if err != nil {
		return Process{}, Server{}, err
	}
	for _, p := range config.Processes {
		if p.ID != processID {
			continue
		}
		for _, s := range config.Servers {
			if s.ID == p.Server {
				return p, s, nil
			}
		}
	}
	return Process{}, Server{}, &UserError{http.StatusNotFound, fmt.Sprintf("'%s' 프로세스가 없습니다", processID)}
}

// ps 는 서버의 프로세스 목록을 돌려준다. fresh 가 아니면 psCacheTTL 안의 결과를 재사용한다.
func (m *Monitor) ps(ctx context.Context, server Server, fresh bool) psSnapshot {
	m.mu.Lock()
	lock := m.serverLocks[server.ID]
	if lock == nil {
		lock = &sync.Mutex{}
		m.serverLocks[server.ID] = lock
	}
	m.mu.Unlock()

	// 같은 서버를 동시에 요청하면 먼저 온 요청이 끝날 때까지 기다렸다가 그 결과를 쓴다.
	lock.Lock()
	defer lock.Unlock()

	m.mu.Lock()
	cached, ok := m.snapshots[server.ID]
	m.mu.Unlock()
	if ok && !fresh && time.Since(cached.at) < psCacheTTL {
		return cached
	}

	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	output, err := m.remote.run(ctx, server, psCommand)
	snapshot := psSnapshot{at: time.Now(), rows: parsePS(output), err: err}

	m.mu.Lock()
	m.snapshots[server.ID] = snapshot
	m.mu.Unlock()
	return snapshot
}

// "  1234  0.5  1.2    01:02:03 java -jar app.jar" 형식의 ps 출력을 읽는다.
var psLine = regexp.MustCompile(`^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$`)

func parsePS(output string) []Instance {
	var rows []Instance
	for _, line := range strings.Split(output, "\n") {
		match := psLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		pid, _ := strconv.Atoi(match[1])
		cpu, _ := strconv.ParseFloat(match[2], 64)
		mem, _ := strconv.ParseFloat(match[3], 64)
		rows = append(rows, Instance{PID: pid, CPU: cpu, Mem: mem, Elapsed: match[4], Command: strings.TrimSpace(match[5])})
	}
	return rows
}

// matchInstances 는 명령줄이 프로세스의 match 정규식에 맞는 행을 고른다.
// 상태 확인용으로 실행한 ps 자체와 PID 1 은 제외한다.
func matchInstances(process Process, rows []Instance) []Instance {
	pattern, err := regexp.Compile(process.Match)
	if err != nil {
		return []Instance{}
	}
	instances := []Instance{}
	for _, row := range rows {
		if row.PID > 1 && !strings.Contains(row.Command, psArgs) && pattern.MatchString(row.Command) {
			instances = append(instances, row)
		}
	}
	return instances
}

func pidList(instances []Instance) string {
	pids := make([]string, len(instances))
	for i, instance := range instances {
		pids[i] = strconv.Itoa(instance.PID)
	}
	return strings.Join(pids, " ")
}

// "-rw-r--r--  1 1000  1000  1234 Nov 19 11:15 app.log" 형식의 ls -ln 출력을 읽는다. (LC_ALL=C)
// 날짜는 "Nov 19 11:15" 또는 "Nov 19  2025". 장치 파일처럼 크기 자리가 다른 줄과 "total" 줄은 건너뛴다.
var lsLine = regexp.MustCompile(`^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s(.+)$`)

func parseLS(output string) []FileEntry {
	var dirs, others []FileEntry
	for _, line := range strings.Split(output, "\n") {
		match := lsLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		size, _ := strconv.ParseInt(match[2], 10, 64)
		entry := FileEntry{Name: match[4], Size: size, Modified: match[3]}
		switch match[1] {
		case "d":
			entry.Type = "dir"
		case "-":
			entry.Type = "file"
		case "l":
			entry.Type = "link"
			if name, target, ok := strings.Cut(entry.Name, " -> "); ok {
				entry.Name, entry.Target = name, target
			}
		default:
			entry.Type = "other"
		}
		if entry.Type == "dir" {
			dirs = append(dirs, entry)
		} else {
			others = append(others, entry)
		}
	}
	return append(append([]FileEntry{}, dirs...), others...)
}
