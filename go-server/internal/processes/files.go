package processes

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// 프로세스마다 등록한 파일 패턴(logFiles · iniFiles)에 맞는 파일만 다룬다. 폴더를 둘러보는 기능은 없다.
//
//	log : 로그 파일 패턴에 맞는 파일 목록, 파일은 tail 로 끝부분만 읽는다.
//	ini : INI 파일 패턴에 맞는 파일 목록, 파일을 통째로 읽고 쓴다.
//
// 목록은 서버의 셸이 패턴을 펼친 결과이고, 읽기 · 쓰기 요청의 경로는 Go 서버가 다시 패턴에 맞는지 확인한다. (resolveFile)
const (
	RootLog = "log"
	RootINI = "ini"
	// 화면에서 편집할 수 있는 INI 파일의 최대 크기
	maxINIBytes = 1 << 20
	// 로그 파일 전체 내려받기의 최대 시간
	downloadTimeout = 30 * time.Minute
)

type FileEntry struct {
	// 절대 경로
	Path string `json:"path"`
	// file · link (패턴에 맞은 폴더 · 장치 파일은 목록에서 뺀다)
	Type string `json:"type"`
	Size int64  `json:"size"`
	// ls 가 보여주는 수정 시각 그대로 ("Nov 19 11:15", 오래된 파일은 "Nov 19  2025")
	Modified string `json:"modified"`
	// 심볼릭 링크가 가리키는 경로
	Target string `json:"target,omitempty"`
}

type FileList struct {
	// 등록한 패턴
	Patterns []string `json:"patterns"`
	// 최근 수정 순
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

// Files 는 프로세스의 로그 · INI 파일 패턴에 맞는 파일을 최근 수정 순으로 돌려준다.
func (m *Monitor) Files(ctx context.Context, processID, root string) (*FileList, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return nil, err
	}
	patterns, err := filePatterns(process, root)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	// 패턴은 따옴표 없이 넣어 셸이 펼치게 한다. (Validate 에서 경로 문자와 * ? 만 허용했다)
	// 맞는 파일이 없는 패턴은 ls 가 "없음" 오류를 내므로 오류 출력과 종료 코드는 무시한다.
	command := fmt.Sprintf("LC_ALL=C ls -lndt -- %s 2>/dev/null | head -n %d; exit 0", strings.Join(patterns, " "), maxLogEntries+1)
	output, err := m.remote.run(ctx, server, command)
	if err != nil {
		return nil, err
	}
	entries := []FileEntry{}
	for _, entry := range parseLS(output) {
		// 셸이 펼친 결과도 한 번 더 패턴과 맞춰 본다. (파일 이름에 공백 등이 있어 잘못 읽은 줄을 거르기 위해)
		if (entry.Type == "file" || entry.Type == "link") && matchesAny(patterns, entry.Path) {
			entries = append(entries, entry)
		}
	}
	list := &FileList{Patterns: patterns, Entries: entries}
	if len(entries) > maxLogEntries {
		list.Entries, list.Truncated = entries[:maxLogEntries], true
	}
	return list, nil
}

// Log 는 로그 파일 패턴에 맞는 file 의 마지막 lines 줄을 돌려준다.
func (m *Monitor) Log(ctx context.Context, processID, file string, lines int) (string, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return "", err
	}
	if err := resolveFile(process, RootLog, file); err != nil {
		return "", err
	}
	lines = max(1, min(lines, maxLogLines))

	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return m.remote.run(ctx, server, fmt.Sprintf("tail -n %d -- '%s'", lines, file))
}

// DownloadLog 는 로그 파일 패턴에 맞는 file 을 통째로 내려보낸다.
// 먼저 크기를 재서 start(size) 로 알려주고(응답 헤더용), 받은 writer 로 그 크기만큼만 흘려보낸다.
// (내려받는 동안 로그가 늘어나도 보낸 길이가 알려준 크기와 맞도록)
// start 를 부른 뒤의 실패는 이미 일부를 보낸 뒤일 수 있다.
func (m *Monitor) DownloadLog(ctx context.Context, processID, file string, start func(size int64) io.Writer) error {
	process, server, err := m.find(processID)
	if err != nil {
		return err
	}
	if err := resolveFile(process, RootLog, file); err != nil {
		return err
	}

	sizeCtx, cancel := context.WithTimeout(ctx, commandTimeout)
	output, err := m.remote.run(sizeCtx, server, fmt.Sprintf(
		`f='%s'; [ -f "$f" ] || { echo '파일이 없습니다' >&2; exit 1; }; [ -r "$f" ] || { echo '읽기 권한이 없습니다' >&2; exit 1; }; wc -c < "$f"`, file))
	cancel()
	if err != nil {
		return err
	}
	size, err := strconv.ParseInt(strings.TrimSpace(output), 10, 64)
	if err != nil {
		return fmt.Errorf("파일 크기를 읽지 못했습니다: %q", output)
	}

	w := start(size)
	// 파일이 클 수 있어 시간 제한을 길게 둔다. 브라우저가 내려받기를 취소하면 ctx 가 끝나 함께 멈춘다.
	streamCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	return m.remote.stream(streamCtx, server, fmt.Sprintf("head -c %d -- '%s'", size, file), w)
}

// ReadINI 는 INI 파일 패턴에 맞는 file 을 통째로 읽는다.
func (m *Monitor) ReadINI(ctx context.Context, processID, file string) (*INIFile, error) {
	server, err := m.findINI(processID, file)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return m.readINI(ctx, server, file)
}

// WriteINI 는 INI 파일 패턴에 맞는 file 을 content 로 바꾼다. baseHash 는 화면이 읽었던 내용의 hash 로,
// 지금 파일과 다르면(그 사이 다른 곳에서 고쳤으면) 덮어쓰지 않고 409 를 돌려준다.
// 바꾸기 전 내용은 같은 폴더의 '<파일>.bak' 에 남긴다.
func (m *Monitor) WriteINI(ctx context.Context, processID, file, content, baseHash string) (*INIFile, error) {
	server, err := m.findINI(processID, file)
	if err != nil {
		return nil, err
	}
	if len(content) > maxINIBytes {
		return nil, &UserError{http.StatusRequestEntityTooLarge, "1MB 를 넘는 파일은 저장할 수 없습니다"}
	}

	// 같은 파일을 동시에 저장하지 않는다.
	key := "ini:" + processID + ":" + file
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

func (m *Monitor) findINI(processID, file string) (Server, error) {
	process, server, err := m.find(processID)
	if err != nil {
		return Server{}, err
	}
	return server, resolveFile(process, RootINI, file)
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

// filePatterns 는 root(log · ini)에 실제로 쓰는 파일 패턴이다. (Process.EffectivePatterns)
func filePatterns(process Process, root string) ([]string, error) {
	if root != RootLog && root != RootINI {
		return nil, &UserError{http.StatusBadRequest, fmt.Sprintf("알 수 없는 파일 종류입니다: %s", root)}
	}
	patterns, problem := process.EffectivePatterns(root)
	if problem != "" {
		return nil, &UserError{http.StatusBadRequest, problem}
	}
	return patterns, nil
}

// resolveFile 은 화면이 고른 파일이 등록한 패턴에 맞는지 확인한다. 맞지 않으면 열지 않는다.
// 경로는 작은따옴표로 감싸 명령에 넣으므로 작은따옴표와 제어 문자도 거부한다.
// (패턴에 맞는 심볼릭 링크가 가리키는 곳까지 막지는 않는다)
func resolveFile(process Process, root, file string) error {
	patterns, err := filePatterns(process, root)
	if err != nil {
		return err
	}
	if file == "" {
		return &UserError{http.StatusBadRequest, "파일을 골라야 합니다"}
	}
	invalid := &UserError{http.StatusBadRequest, fmt.Sprintf("등록한 패턴에 맞지 않는 파일입니다: %s", file)}
	if !strings.HasPrefix(file, "/") || path.Clean(file) != file {
		return invalid
	}
	for _, r := range file {
		if r == '\'' || r < 0x20 || r == 0x7f {
			return invalid
		}
	}
	if !matchesAny(patterns, file) {
		return invalid
	}
	return nil
}

// "-rw-r--r--  1 1000  1000  1234 Nov 19 11:15 /opt/app/logs/app.log" 형식의 ls -ln 출력을 읽는다. (LC_ALL=C)
// 날짜는 "Nov 19 11:15" 또는 "Nov 19  2025". 장치 파일처럼 크기 자리가 다른 줄은 건너뛴다. 순서는 ls 그대로 둔다.
var lsLine = regexp.MustCompile(`^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s(.+)$`)

func parseLS(output string) []FileEntry {
	entries := []FileEntry{}
	for _, line := range strings.Split(output, "\n") {
		match := lsLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		size, _ := strconv.ParseInt(match[2], 10, 64)
		entry := FileEntry{Path: match[4], Size: size, Modified: match[3]}
		switch match[1] {
		case "d":
			entry.Type = "dir"
		case "-":
			entry.Type = "file"
		case "l":
			entry.Type = "link"
			if name, target, ok := strings.Cut(entry.Path, " -> "); ok {
				entry.Path, entry.Target = name, target
			}
		default:
			entry.Type = "other"
		}
		entries = append(entries, entry)
	}
	return entries
}
