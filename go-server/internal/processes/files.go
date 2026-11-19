package processes

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 프로세스마다 등록한 두 폴더 아래의 파일을 다룬다.
//
//	log : 로그 폴더(logDir)  - 모든 파일 · 폴더를 보여주고, 파일은 tail 로 끝부분만 읽는다.
//	ini : 설정 폴더(configDir) - 폴더와 *.ini 파일만 보여주고, *.ini 파일을 통째로 읽고 쓴다.
//
// 경로는 폴더 기준 상대 경로로 받고, 폴더 밖을 가리키는 경로('..')는 거부한다. (rootPath)
const (
	RootLog = "log"
	RootINI = "ini"
	// 화면에서 편집할 수 있는 INI 파일의 최대 크기
	maxINIBytes = 1 << 20
)

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
	// 폴더 기준 상대 경로 ("" 이면 등록한 폴더)
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
	// maxLogEntries 개를 넘어서 오래된 항목을 잘랐는지
	Truncated bool `json:"truncated,omitempty"`
}

// INIFile 은 화면에서 편집할 INI 파일 내용이다. Hash 는 읽은 내용의 sha256 으로,
// 저장할 때 돌려받아 그 사이에 다른 곳에서 파일이 바뀌지 않았는지 확인한다.
type INIFile struct {
	Content string `json:"content"`
	Hash    string `json:"hash"`
}

// Files 는 프로세스의 로그 · 설정 폴더 아래 rel 폴더의 목록을 최근 수정 순으로 돌려준다. (폴더가 먼저)
// 설정 폴더(ini)는 폴더와 *.ini 파일만 보여준다.
func (m *Monitor) Files(ctx context.Context, processID, root, rel string) (*FileList, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return nil, err
	}
	dir, err := rootPath(process, root, rel)
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
	if root == RootINI {
		kept := []FileEntry{}
		for _, entry := range entries {
			if entry.Type == "dir" || (entry.Type != "other" && isINI(entry.Name)) {
				kept = append(kept, entry)
			}
		}
		entries = kept
	}
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
	file, err := rootPath(process, RootLog, rel)
	if err != nil {
		return "", err
	}
	lines = max(1, min(lines, maxLogLines))

	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return m.remote.run(ctx, server, fmt.Sprintf("tail -n %d -- '%s'", lines, file))
}

// ReadINI 는 프로세스 설정 폴더 아래 rel(*.ini) 파일을 통째로 읽는다.
func (m *Monitor) ReadINI(ctx context.Context, processID, rel string) (*INIFile, error) {
	_, server, file, err := m.findINI(processID, rel)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return m.readINI(ctx, server, file)
}

// WriteINI 는 rel(*.ini) 파일을 content 로 바꾼다. baseHash 는 화면이 읽었던 내용의 hash 로,
// 지금 파일과 다르면(그 사이 다른 곳에서 고쳤으면) 덮어쓰지 않고 409 를 돌려준다.
// 바꾸기 전 내용은 같은 폴더의 '<파일>.bak' 에 남긴다.
func (m *Monitor) WriteINI(ctx context.Context, processID, rel, content, baseHash string) (*INIFile, error) {
	_, server, file, err := m.findINI(processID, rel)
	if err != nil {
		return nil, err
	}
	if len(content) > maxINIBytes {
		return nil, &UserError{http.StatusRequestEntityTooLarge, "1MB 를 넘는 파일은 저장할 수 없습니다"}
	}

	// 같은 파일을 동시에 저장하지 않는다.
	key := "ini:" + processID + "/" + rel
	m.mu.Lock()
	if m.busy[key] {
		m.mu.Unlock()
		return nil, &UserError{http.StatusConflict, "이 파일을 저장하는 중입니다"}
	}
	m.busy[key] = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.busy, key)
		m.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(ctx, 2*commandTimeout)
	defer cancel()
	current, err := m.readINI(ctx, server, file)
	if err != nil {
		return nil, err
	}
	if current.Hash != baseHash {
		return nil, &UserError{http.StatusConflict, "파일을 연 뒤 다른 곳에서 바뀌었습니다. 다시 읽은 뒤 고쳐 주세요"}
	}

	// 받은 내용을 임시 파일에 다 쓰고 크기까지 맞는지 본 뒤에만 원본을 바꾼다. (중간에 끊겨도 원본이 잘리지 않게)
	// 원본은 cat > 로 내용만 바꿔 권한 · 소유자를 그대로 둔다.
	command := fmt.Sprintf(`set -e; f='%s'; cat > "$f.pm-new"; `+
		`[ "$(wc -c < "$f.pm-new")" -eq %d ] || { rm -f -- "$f.pm-new"; echo '내용을 끝까지 받지 못했습니다' >&2; exit 1; }; `+
		`cp -p -- "$f" "$f.bak"; cat -- "$f.pm-new" > "$f"; rm -f -- "$f.pm-new"`, file, len(content))
	if _, err := m.remote.runInput(ctx, server, command, []byte(content)); err != nil {
		return nil, fmt.Errorf("저장하지 못했습니다: %w", err)
	}
	return &INIFile{Content: content, Hash: contentHash(content)}, nil
}

func (m *Monitor) findINI(processID, rel string) (Process, Server, string, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return Process{}, Server{}, "", err
	}
	if !isINI(rel) {
		return Process{}, Server{}, "", &UserError{http.StatusBadRequest, ".ini 파일만 열 수 있습니다"}
	}
	file, err := rootPath(process, RootINI, rel)
	return process, server, file, err
}

func (m *Monitor) readINI(ctx context.Context, server Server, file string) (*INIFile, error) {
	command := fmt.Sprintf(`f='%s'; size=$(wc -c < "$f") || exit 1; [ "$size" -le %d ] || { echo '1MB 를 넘는 파일은 열 수 없습니다' >&2; exit 1; }; cat -- "$f"`, file, maxINIBytes)
	content, err := m.remote.run(ctx, server, command)
	if err != nil {
		return nil, err
	}
	// JSON 으로 보내면서 깨진 글자가 바뀌고, 그대로 저장하면 파일이 망가지므로 열지 않는다.
	if !utf8.ValidString(content) {
		return nil, &UserError{http.StatusUnprocessableEntity, "UTF-8 이 아닌 파일(EUC-KR 등)은 열 수 없습니다"}
	}
	return &INIFile{Content: content, Hash: contentHash(content)}, nil
}

func contentHash(content string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
}

func isINI(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".ini")
}

// rootPath 는 로그 · 설정 폴더 아래의 상대 경로를 절대 경로로 바꾼다. 폴더 밖으로 나가는 경로('..')는 거부한다.
// 결과는 작은따옴표로 감싸 명령에 넣으므로 작은따옴표와 제어 문자도 거부한다.
// (폴더 안의 심볼릭 링크가 가리키는 곳까지 막지는 않는다)
func rootPath(process Process, root, rel string) (string, error) {
	var dir string
	switch root {
	case RootLog:
		if dir = process.LogDir; dir == "" {
			return "", &UserError{http.StatusBadRequest, "로그 폴더가 등록되지 않았습니다"}
		}
	case RootINI:
		if dir = process.ConfigDir; dir == "" {
			return "", &UserError{http.StatusBadRequest, "설정(INI) 폴더가 등록되지 않았습니다"}
		}
	default:
		return "", &UserError{http.StatusBadRequest, fmt.Sprintf("알 수 없는 폴더 종류입니다: %s", root)}
	}
	if rel == "" {
		return dir, nil
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
	return dir + "/" + rel, nil
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
