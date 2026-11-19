package endpoints

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sync"
)

// File 은 프론트가 쓰는 엔드포인트 설정 파일(endpoints.json)의 구조. 프론트의 src/config/types.ts 와 맞춘다.
type File struct {
	PollIntervalMs int        `json:"pollIntervalMs,omitempty"`
	Endpoints      []Endpoint `json:"endpoints"`
}

type Endpoint struct {
	ID             string `json:"id"`
	Group          string `json:"group,omitempty"`
	Label          string `json:"label,omitempty"`
	URL            string `json:"url"`
	PollIntervalMs int    `json:"pollIntervalMs,omitempty"`
}

// Validate 는 저장 전에 설정을 검사하고, 문제를 모두 모아서 돌려준다.
func (f *File) Validate() error {
	var errs []error
	if f.PollIntervalMs < 0 {
		errs = append(errs, errors.New("pollIntervalMs: 0 이상이어야 합니다"))
	}
	if f.Endpoints == nil {
		errs = append(errs, errors.New("endpoints: 배열이 필요합니다"))
	}

	seen := make(map[string]bool)
	for i, e := range f.Endpoints {
		path := fmt.Sprintf("endpoints[%d]", i)
		switch {
		case e.ID == "":
			errs = append(errs, fmt.Errorf("%s.id: 비어 있습니다", path))
		case seen[e.ID]:
			errs = append(errs, fmt.Errorf("%s.id: '%s' 가 중복됩니다", path, e.ID))
		}
		seen[e.ID] = true

		if u, err := url.Parse(e.URL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Errorf("%s.url: http:// 또는 https:// 로 시작하는 주소가 필요합니다", path))
		}
		if e.PollIntervalMs < 0 {
			errs = append(errs, fmt.Errorf("%s.pollIntervalMs: 0 이상이어야 합니다", path))
		}
	}
	return errors.Join(errs...)
}

// Store 는 엔드포인트 설정 파일을 읽고 쓴다.
// 저장된 파일이 없으면 빌드에 포함된 기본 설정(defaultPath)을 돌려준다.
type Store struct {
	mu          sync.Mutex
	path        string
	defaultPath string
}

func NewStore(path, defaultPath string) *Store {
	return &Store{path: path, defaultPath: defaultPath}
}

// Load 는 저장된 설정을, 없으면 기본 설정을 원본 그대로 돌려준다.
func (s *Store) Load() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return os.ReadFile(s.defaultPath)
	}
	return data, err
}

// ErrInvalid 는 요청 본문이 잘못된 경우의 에러. ( 400 으로 응답 )
var ErrInvalid = errors.New("invalid endpoints config")

// Save 는 body 를 검사한 뒤 보기 좋게 정리해서 저장하고, 저장한 내용을 돌려준다.
// 쓰는 도중 실패해도 기존 파일이 깨지지 않도록 임시 파일에 쓴 뒤 바꿔치기한다.
func (s *Store) Save(body []byte) ([]byte, error) {
	var f File
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if err := f.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalid, err)
	}

	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".endpoints-*.json")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name()) // rename 에 성공하면 이미 없으므로 무시된다.

	// CreateTemp 는 0600 으로 만들므로 일반 설정 파일 권한으로 맞춘다.
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return nil, err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		return nil, err
	}
	return data, nil
}
