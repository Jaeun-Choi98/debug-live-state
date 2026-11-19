import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileList, ProcessEntry } from '../../config/types';
import { requestApi } from '../../hooks/useProcessConfig';
import './LogViewer.css';

interface LogViewerProps {
  process: ProcessEntry;
  serverLabel: string;
  onClose: () => void;
}

const LINE_OPTIONS = [100, 200, 500, 1000, 2000];
const AUTO_REFRESH_MS = 3000;

/** 아래에서 process 를 프로세스 항목 이름으로 쓰므로 환경 변수는 여기서 읽어 둔다. */
const PROCESSES_API = `${process.env.PUBLIC_URL}/api/processes`;

const formatSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KB`
      : size < 1024 ** 3
        ? `${(size / 1024 ** 2).toFixed(1)} MB`
        : `${(size / 1024 ** 3).toFixed(2)} GB`;

/**
 * 로그 폴더(logDir) 아래를 둘러보다가(폴더 → 파일 목록) 파일을 고르면 끝부분(tail -n)을 보여준다.
 * 파일 화면에서 자동 새로고침을 켜면 3초마다 다시 읽는다.
 */
const LogViewer: React.FC<LogViewerProps> = ({ process: target, serverLabel, onClose }) => {
  /** 보고 있는 폴더 (로그 폴더 기준 상대 경로, '' 이면 로그 폴더) */
  const [dir, setDir] = useState('');
  /** 고른 파일 (상대 경로). null 이면 폴더 목록 화면 */
  const [file, setFile] = useState<string | null>(null);
  const [list, setList] = useState<FileList | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [lines, setLines] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [filter, setFilter] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  /** 사용자가 맨 아래를 보고 있으면 새 로그가 와도 맨 아래를 유지한다. */
  const stickToBottomRef = useRef(true);

  const loadList = useCallback(async () => {
    setList(null);
    setListError(null);
    try {
      setList(await requestApi<FileList>(`${PROCESSES_API}/${encodeURIComponent(target.id)}/files?path=${encodeURIComponent(dir)}`));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, [target.id, dir]);

  useEffect(() => {
    if (file === null) loadList();
  }, [loadList, file]);

  const load = useCallback(async () => {
    if (file === null) return;
    setLoading(true);
    try {
      const body = await requestApi<{ output: string }>(
        `${PROCESSES_API}/${encodeURIComponent(target.id)}/log?path=${encodeURIComponent(file)}&lines=${lines}`
      );
      setOutput(body.output);
      setError(null);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [target.id, file, lines]);

  useEffect(() => {
    if (file === null) return;
    load();
    if (!autoRefresh) return;
    const timer = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, autoRefresh, file]);

  const openFile = (path: string) => {
    setOutput(null);
    setError(null);
    setFilter('');
    stickToBottomRef.current = true;
    setFile(path);
  };
  const closeFile = () => {
    setFile(null);
    setAutoRefresh(false);
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [output, filter]);

  const escapeRef = useRef<() => void>(onClose);
  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => e.key === 'Escape' && escapeRef.current();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  // Esc 는 파일 화면이면 목록으로, 목록 화면이면 창을 닫는다.
  escapeRef.current = file === null ? onClose : closeFile;

  /** 경로 막대: 로그 폴더 / 하위 폴더 / 파일. 폴더를 누르면 그 폴더 목록으로 간다. */
  const segments = (file ?? dir).split('/').filter(Boolean);
  const crumbs = (
    <nav className="log-viewer-crumbs">
      <button
        className="log-viewer-linkbtn"
        onClick={() => {
          setFile(null);
          setDir('');
        }}
        title={target.logDir}
      >
        {target.logDir}
      </button>
      {segments.map((segment, i) => {
        const isFile = file !== null && i === segments.length - 1;
        const path = segments.slice(0, i + 1).join('/');
        return (
          <React.Fragment key={path}>
            <span>/</span>
            {isFile ? (
              <strong>{segment}</strong>
            ) : (
              <button
                className="log-viewer-linkbtn"
                onClick={() => {
                  closeFile();
                  setDir(path);
                }}
              >
                {segment}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );

  const lowerFilter = filter.toLowerCase();
  const shownLines = (output ?? '')
    .replace(/\n$/, '')
    .split('\n')
    .filter(line => line.toLowerCase().includes(lowerFilter));

  return (
    <div className="log-viewer-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="log-viewer" role="dialog" aria-modal="true" aria-label="로그 보기">
        <header className="log-viewer-header">
          <div className="log-viewer-title">
            <strong>{target.label || target.id}</strong>
            <span>{serverLabel}</span>
          </div>
          <button className="btn-icon" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <div className="log-viewer-pathbar">
          {file !== null && (
            <button className="btn btn-secondary" onClick={closeFile} title="목록으로 (Esc)">
              ← 목록
            </button>
          )}
          {crumbs}
          {file === null && (
            <button className="btn btn-secondary log-viewer-pathbar-refresh" onClick={loadList}>
              ↻ 새로고침
            </button>
          )}
        </div>

        {file === null ? (
          <div className="log-viewer-files">
            {listError && <div className="log-viewer-error">{listError}</div>}
            {!list && !listError && <div className="log-viewer-placeholder">읽는 중...</div>}
            {list && list.entries.length === 0 && <div className="log-viewer-placeholder">(비어 있음)</div>}
            {list && list.entries.length > 0 && (
              <table className="log-viewer-file-table">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th className="log-viewer-num">크기</th>
                    <th>수정 시각</th>
                  </tr>
                </thead>
                <tbody>
                  {list.entries.map(entry => {
                    const path = dir ? `${dir}/${entry.name}` : entry.name;
                    const open = entry.type === 'dir' ? () => setDir(path) : entry.type === 'other' ? undefined : () => openFile(path);
                    return (
                      <tr key={entry.name}>
                        <td>
                          {open ? (
                            <button
                              className="log-viewer-linkbtn log-viewer-file-name"
                              onClick={open}
                              title={entry.target ? `→ ${entry.target}` : undefined}
                            >
                              {entry.type === 'dir' ? '📁' : '📄'} {entry.name}
                              {entry.type === 'dir' && '/'}
                              {entry.target && <span className="log-viewer-link"> → {entry.target}</span>}
                            </button>
                          ) : (
                            <span className="log-viewer-file-name log-viewer-file-other">{entry.name}</span>
                          )}
                        </td>
                        <td className="log-viewer-num">{entry.type === 'dir' ? '' : formatSize(entry.size)}</td>
                        <td className="log-viewer-modified">{entry.modified}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {list?.truncated && <div className="log-viewer-placeholder">항목이 많아 최근 수정된 {list.entries.length}개만 보여줍니다.</div>}
          </div>
        ) : (
          <>
            <div className="log-viewer-toolbar">
              <label>
                마지막
                <select className="input" value={lines} onChange={e => setLines(Number(e.target.value))}>
                  {LINE_OPTIONS.map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                줄
              </label>
              <input
                className="input log-viewer-filter"
                placeholder="이 단어가 있는 줄만 보기"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
              <label>
                <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
                자동 새로고침 (3초)
              </label>
              <button className="btn btn-secondary" onClick={load} disabled={loading}>
                {loading ? '읽는 중...' : '↻ 새로고침'}
              </button>
              <span className="log-viewer-time">{fetchedAt && fetchedAt.toLocaleTimeString()}</span>
            </div>

            {error && <div className="log-viewer-error">{error}</div>}
            <pre
              ref={bodyRef}
              className="log-viewer-body"
              onScroll={e => {
                const el = e.currentTarget;
                stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
            >
              {output === null
                ? '읽는 중...'
                : shownLines.length === 0 || (shownLines.length === 1 && shownLines[0] === '')
                  ? filter
                    ? '일치하는 줄이 없습니다.'
                    : '(비어 있음)'
                  : shownLines.join('\n')}
            </pre>
          </>
        )}
      </div>
    </div>
  );
};

export default LogViewer;
