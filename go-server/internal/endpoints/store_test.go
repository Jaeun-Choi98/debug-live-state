package endpoints

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) (*Store, string, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "data", "endpoints.json")
	defaultPath := filepath.Join(dir, "default.json")
	if err := os.WriteFile(defaultPath, []byte(`{"endpoints":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewStore(path, defaultPath), path, defaultPath
}

func TestLoadFallsBackToDefault(t *testing.T) {
	store, _, _ := newTestStore(t)
	data, err := store.Load()
	if err != nil || string(data) != `{"endpoints":[]}` {
		t.Fatalf("Load() = %q, %v; want default file", data, err)
	}
}

func TestSaveWritesAndLoadReadsSaved(t *testing.T) {
	store, path, _ := newTestStore(t)
	saved, err := store.Save([]byte(`{"endpoints":[{"id":"a","url":"http://localhost:8081/state"}]}`))
	if err != nil {
		t.Fatalf("Save() error: %v", err)
	}

	onDisk, _ := os.ReadFile(path)
	if string(onDisk) != string(saved) {
		t.Fatalf("file on disk = %q, want %q", onDisk, saved)
	}
	loaded, _ := store.Load()
	if string(loaded) != string(saved) {
		t.Fatalf("Load() = %q, want saved content", loaded)
	}

	// 임시 파일이 남지 않아야 한다.
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("data dir has %d entries, want only endpoints.json", len(entries))
	}
}

func TestSaveRejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"not json":      `{`,
		"unknown field": `{"endpoints":[],"extra":1}`,
		"no endpoints":  `{}`,
		"empty id":      `{"endpoints":[{"id":"","url":"http://x"}]}`,
		"duplicate id":  `{"endpoints":[{"id":"a","url":"http://x"},{"id":"a","url":"http://y"}]}`,
		"bad url":       `{"endpoints":[{"id":"a","url":"ftp://x"}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			store, path, _ := newTestStore(t)
			if _, err := store.Save([]byte(body)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("Save() error = %v, want ErrInvalid", err)
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid config must not be written")
			}
		})
	}
}

func TestValidateReportsAllErrors(t *testing.T) {
	f := File{Endpoints: []Endpoint{{ID: "", URL: "x"}, {ID: "b", URL: "http://ok", PollIntervalMs: -1}}}
	err := f.Validate()
	for _, want := range []string{"endpoints[0].id", "endpoints[0].url", "endpoints[1].pollIntervalMs"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Validate() = %v, want it to mention %s", err, want)
		}
	}
}
