import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileList, ProcessEntry } from '../../config/types';
import { requestApi } from '../../hooks/useProcessConfig';
import IniEditor from '../IniEditor/IniEditor';
import { effectivePatterns } from '../../config/schema';
import './LogViewer.css';

/** log: 로그 파일 패턴(logFiles), 파일은 tail 로 보기 / ini: INI 파일 패턴(iniFiles), 파일은 편집 */
export type FileRoot = 'log' | 'ini';

interface LogViewerProps {
  process: ProcessEntry;
  serverLabel: string;
  root: FileRoot;
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

/** "/opt/app/logs/app.log" → ["/opt/app/logs/", "app.log"] (목록에서 파일 이름만 굵게 보여주려고) */
const splitPath = (path: string) => {
  const slash = path.lastIndexOf('/') + 1;
  return [path.slice(0, slash), path.slice(slash)];
};

/**
 * 프로세스에 등록한 파일 패턴에 맞는 파일을 최근 수정 순으로 보여주고(폴더를 둘러보지는 않는다), 파일을 고르면
 *   - 로그(root=log): 끝부분(tail -n)을 보여준다. 자동 새로고침을 켜면 3초마다 다시 읽는다.
 *   - INI(root=ini): 편집기(IniEditor)로 열어 고치고 저장한다.
 */
const LogViewer: React.FC<LogViewerProps> = ({ process: target, serverLabel, root, onClose }) => {
  /** INI 편집기에 저장하지 않은 변경이 있는지 (떠날 때 확인) */
  const [dirty, setDirty] = useState(false);
  /** 저장하지 않은 변경이 있으면 버릴지 묻고, 버려도 되면 action 을 실행한다. */
  const leave = (action: () => void) => {
    if (dirty && !window.confirm('저장하지 않은 변경이 있습니다. 버릴까요?')) return;
    setDirty(false);
    action();
  };

  /** 고른 파일 (절대 경로). null 이면 목록 화면 */
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
      setList(await requestApi<FileList>(`${PROCESSES_API}/${encodeURIComponent(target.id)}/files?root=${root}`));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, [target.id, root]);

  useEffect(() => {
    if (file === null) loadList();
  }, [loadList, file]);

  const load = useCallback(async () => {
    if (file === null || root !== 'log') return;
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
  }, [target.id, root, file, lines]);

  useEffect(() => {
    if (file === null || root !== 'log') return;
    load();
    if (!autoRefresh) return;
    const timer = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, autoRefresh, file, root]);

  const openFile = (path: string) => {
    setOutput(null);
    setError(null);
    setFilter('');
    stickToBottomRef.current = true;
    setFile(path);
  };
  const closeFile = () =>
    leave(() => {
      setFile(null);
      setAutoRefresh(false);
    });
  const close = () => leave(onClose);

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
  escapeRef.current = file === null ? close : closeFile;

  const lowerFilter = filter.toLowerCase();
  const shownLines = (output ?? '')
    .replace(/\n$/, '')
    .split('\n')
    .filter(line => line.toLowerCase().includes(lowerFilter));

  /**
   * 지금 화면에 보이는 줄(마지막 N줄, 거르기를 했으면 걸러진 줄)만 파일로 내려받는다.
   * 이름은 원래 파일 이름에 범위를 붙인다. 예) app.log → app.last200.log, 거르기 → app.last200.filtered.log
   */
  const exportShown = () => {
    if (file === null || output === null) return;
    const [, name] = splitPath(file);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const blob = new Blob([shownLines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${stem}.last${lines}${filter ? '.filtered' : ''}${ext}`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="log-viewer-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="log-viewer" role="dialog" aria-modal="true" aria-label={root === 'ini' ? 'INI 편집' : '로그 보기'}>
        <header className="log-viewer-header">
          <div className="log-viewer-title">
            <strong>{target.label || target.id}</strong>
            <span>{serverLabel}</span>
            <span className="log-viewer-kind">{root === 'ini' ? 'INI 설정' : '로그'}</span>
          </div>
          <button className="btn-icon" onClick={close} title="닫기">
            ✕
          </button>
        </header>

        <div className="log-viewer-pathbar">
          {file !== null && (
            <button className="btn btn-secondary" onClick={closeFile} title="목록으로 (Esc)">
              ← 목록
            </button>
          )}
          {file === null ? (
            <span className="log-viewer-patterns" title="이 패턴에 맞는 파일만 보입니다 (⚙ 설정에서 비워 두면 시작 스크립트 폴더 기준)">
              {(list?.patterns ?? effectivePatterns(target, root).patterns).join('\n')}
            </span>
          ) : (
            <span className="log-viewer-patterns">
              {splitPath(file)[0]}
              <strong>{splitPath(file)[1]}</strong>
            </span>
          )}
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
            {list && list.entries.length === 0 && <div className="log-viewer-placeholder">패턴에 맞는 파일이 없습니다.</div>}
            {list && list.entries.length > 0 && (
              <table className="log-viewer-file-table">
                <thead>
                  <tr>
                    <th>파일</th>
                    <th className="log-viewer-num">크기</th>
                    <th>수정 시각</th>
                  </tr>
                </thead>
                <tbody>
                  {list.entries.map(entry => {
                    const [dir, name] = splitPath(entry.path);
                    return (
                      <tr key={entry.path}>
                        <td>
                          <button
                            className="log-viewer-linkbtn log-viewer-file-name"
                            onClick={() => openFile(entry.path)}
                            title={entry.target ? `${entry.path} → ${entry.target}` : entry.path}
                          >
                            <span className="log-viewer-file-dir">{dir}</span>
                            {name}
                            {entry.target && <span className="log-viewer-link"> → {entry.target}</span>}
                          </button>
                        </td>
                        <td className="log-viewer-num">{formatSize(entry.size)}</td>
                        <td className="log-viewer-modified">{entry.modified}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {list?.truncated && <div className="log-viewer-placeholder">항목이 많아 최근 수정된 {list.entries.length}개만 보여줍니다.</div>}
          </div>
        ) : root === 'ini' ? (
          <IniEditor processId={target.id} path={file} onDirtyChange={setDirty} />
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
              <span className="log-viewer-export">
                <button
                  className="btn btn-secondary"
                  onClick={exportShown}
                  disabled={output === null}
                  title={`지금 보이는 ${filter ? '걸러진 ' : ''}줄만 (마지막 ${lines}줄 중 ${shownLines.length}줄) 내려받습니다`}
                >
                  ⤓ 화면 내용
                </button>
                {/* 전체 파일은 Go 서버가 첨부 파일로 보낸다. (큰 파일도 메모리에 모으지 않고 흘려보낸다) */}
                <a
                  className="btn btn-secondary"
                  href={`${PROCESSES_API}/${encodeURIComponent(target.id)}/log/download?path=${encodeURIComponent(file)}`}
                  download
                  title="파일 전체를 내려받습니다"
                >
                  ⤓ 전체 파일
                </a>
              </span>
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
