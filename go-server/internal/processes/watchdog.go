package processes

import (
	"context"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/Jaeun-Choi98/modules/logger"
)

// 자동 재시작(autoRestart) 감시
//
//	확인 주기(watchIntervalMs)마다 자동 재시작을 켠 프로세스의 서버에서 ps 를 실행해(캐시 공유) 감시 프로세스를 찾는다.
//	감시 프로세스가 없으면 시작 스크립트를 실행하고, 그 뒤 재시작 대기(restartDelayMs) 동안은 프로세스가 뜨기를 기다린다.
//	계속 뜨지 않으면 재시작 대기마다 횟수 제한 없이 다시 시작한다. 두 값은 설정 파일에서 매번 읽으므로 저장하면 바로 반영된다.
//
//	감시 프로세스: ps 명령줄 첫 단어의 파일 이름이 watchName 과 같고, 명령줄에 watchArgs 가 들어 있는 프로세스.
//	둘 중 비워 둔 조건은 보지 않는다. (둘 다 비우면 감시하지 않는다)
//	화면 표시용 match 정규식과 따로 두어, 자동으로 실행할지는 정확한 비교로만 정한다.
const (
	defaultWatchInterval = 10 * time.Second
	defaultRestartDelay  = 30 * time.Second
)

// watchInterval 은 자동 재시작 확인 주기다. (설정에 없으면 기본값)
func (c *Config) watchInterval() time.Duration {
	if c.WatchIntervalMs > 0 {
		return time.Duration(c.WatchIntervalMs) * time.Millisecond
	}
	return defaultWatchInterval
}

// restartDelay 는 시작한 뒤 다시 자동 시작하기 전까지 기다리는 시간이다. (설정에 없으면 기본값)
func (c *Config) restartDelay() time.Duration {
	if c.RestartDelayMs > 0 {
		return time.Duration(c.RestartDelayMs) * time.Millisecond
	}
	return defaultRestartDelay
}

type WatchStatus struct {
	// 감시 프로세스가 지금 ps 에 있는지
	Healthy bool `json:"healthy"`
	// 화면에서 중지해 자동 재시작이 멈춘 상태. 시작 · 재시작하면 다시 켜진다.
	Paused bool `json:"paused,omitempty"`
	// Go 서버가 켜진 뒤 자동으로 시작한 횟수
	Restarts int `json:"restarts"`
	// 마지막으로 자동 시작한 시각
	LastRestartAt *time.Time `json:"lastRestartAt,omitempty"`
	// 마지막 자동 시작 · 상태 확인의 오류 (성공하면 비운다)
	LastError string `json:"lastError,omitempty"`
}

// watchState 는 Go 서버 메모리에만 둔다. Go 서버를 다시 켜면 '중지로 멈춤' 도 풀린다.
type watchState struct {
	paused bool
	// 마지막 시작 시각 (자동 · 화면 모두). 이후 재시작 대기 동안은 자동으로 시작하지 않는다.
	lastAttempt   time.Time
	restarts      int
	lastRestartAt time.Time
	lastError     string
}

// watch 는 m.mu 를 잡은 상태에서 호출한다.
func (m *Monitor) watch(processID string) *watchState {
	state := m.watches[processID]
	if state == nil {
		state = &watchState{}
		m.watches[processID] = state
	}
	return state
}

// StartWatchdog 은 자동 재시작 감시를 시작한다. Close 하면 멈춘다.
func (m *Monitor) StartWatchdog() {
	ctx, cancel := context.WithCancel(context.Background())
	m.stopWatchdog = cancel
	go func() {
		// 확인 주기가 설정에서 바뀔 수 있으므로 매번 설정에서 읽어 다음 확인까지 기다린다.
		interval := defaultWatchInterval
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(interval):
				interval = m.watchOnce(ctx)
			}
		}
	}()
}

// watchOnce 는 자동 재시작을 켠 모든 프로세스를 서버마다 동시에 한 번 확인하고, 다음 확인까지의 간격을 돌려준다.
func (m *Monitor) watchOnce(ctx context.Context) time.Duration {
	config, err := m.store.Load()
	if err != nil {
		logger.Errorf("[WATCHDOG] failed to load processes config, err: %v", err)
		return defaultWatchInterval
	}
	delay := config.restartDelay()
	servers := map[string]Server{}
	for _, s := range config.Servers {
		servers[s.ID] = s
	}
	watched := map[string][]Process{}
	for _, p := range config.Processes {
		if p.AutoRestart && p.watches() && p.StartScript != "" {
			watched[p.Server] = append(watched[p.Server], p)
		}
	}

	var wg sync.WaitGroup
	for serverID, list := range watched {
		server, ok := servers[serverID]
		if !ok {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			snapshot := m.ps(ctx, server, false)
			for _, p := range list {
				m.watchProcess(ctx, server, p, snapshot, delay)
			}
		}()
	}
	wg.Wait()
	return config.watchInterval()
}

func (m *Monitor) watchProcess(ctx context.Context, server Server, process Process, snapshot psSnapshot, delay time.Duration) {
	m.mu.Lock()
	state := m.watch(process.ID)
	if snapshot.err != nil {
		state.lastError = "상태 확인 실패: " + snapshot.err.Error()
		m.mu.Unlock()
		return
	}
	if len(watchInstances(process, snapshot.rows)) > 0 {
		state.lastError = ""
		m.mu.Unlock()
		return
	}
	// 화면에서 중지했거나, 방금 시작해 뜨기를 기다리는 중이거나, 화면에서 시작 · 중지가 진행 중이면 건너뛴다.
	if state.paused || time.Since(state.lastAttempt) < delay || m.busy[process.ID] {
		m.mu.Unlock()
		return
	}
	m.busy[process.ID] = true
	state.lastAttempt = time.Now()
	m.mu.Unlock()

	err := m.runStart(ctx, server, process)

	m.mu.Lock()
	delete(m.busy, process.ID)
	state.restarts++
	state.lastRestartAt = time.Now()
	state.lastError = ""
	if err != nil {
		state.lastError = err.Error()
	}
	restarts := state.restarts
	m.mu.Unlock()

	if err != nil {
		logger.Errorf("[WATCHDOG] %s: 감시 프로세스가 없어 시작했지만 실패 (%d번째), err: %v", process.ID, restarts, err)
	} else {
		logger.Warnf("[WATCHDOG] %s: 감시 프로세스가 없어 시작 스크립트를 실행했습니다 (%d번째)", process.ID, restarts)
	}
}

// watchStatus 는 상태 응답에 넣을 감시 상태다. 감시 조건을 등록하지 않았으면 nil.
func (m *Monitor) watchStatus(process Process, rows []Instance) *WatchStatus {
	if !process.watches() {
		return nil
	}
	status := &WatchStatus{Healthy: len(watchInstances(process, rows)) > 0}

	m.mu.Lock()
	defer m.mu.Unlock()
	if state := m.watches[process.ID]; state != nil {
		status.Paused = state.paused
		status.Restarts = state.restarts
		status.LastError = state.lastError
		if !state.lastRestartAt.IsZero() {
			at := state.lastRestartAt
			status.LastRestartAt = &at
		}
	}
	return status
}

// watches 는 감시 조건(감시 이름 · 감시 문자열)이 하나라도 있는지다.
func (p Process) watches() bool { return p.WatchName != "" || p.WatchArgs != "" }

// watchInstances 는 감시 프로세스(실행 파일 이름 = watchName, 명령줄에 watchArgs 포함)를 고른다. 비워 둔 조건은 보지 않는다.
// 상태 확인용으로 실행한 ps 자체와 PID 1 은 제외한다.
func watchInstances(process Process, rows []Instance) []Instance {
	instances := []Instance{}
	if !process.watches() {
		return instances
	}
	for _, row := range rows {
		fields := strings.Fields(row.Command)
		if row.PID <= 1 || len(fields) == 0 || strings.Contains(row.Command, psArgs) {
			continue
		}
		nameOK := process.WatchName == "" || path.Base(fields[0]) == process.WatchName
		if nameOK && strings.Contains(row.Command, process.WatchArgs) {
			instances = append(instances, row)
		}
	}
	return instances
}

// WatchTest 는 감시 조건(name · args)으로 지금 서버의 ps 에서 찾은 프로세스를 돌려준다.
// 모니터링 화면에서 감시 조건을 저장하기 전에 맞는 프로세스를 확인하는 데 쓴다.
func (m *Monitor) WatchTest(ctx context.Context, processID, name, args string) ([]Instance, error) {
	_, server, err := m.find(processID)
	if err != nil {
		return nil, err
	}
	process := Process{WatchName: strings.TrimSpace(name), WatchArgs: strings.TrimSpace(args)}
	if !process.watches() {
		return nil, &UserError{http.StatusBadRequest, "감시 이름이나 감시 문자열을 적어야 합니다"}
	}
	snapshot := m.ps(ctx, server, false)
	if snapshot.err != nil {
		return nil, snapshot.err
	}
	return watchInstances(process, snapshot.rows), nil
}
