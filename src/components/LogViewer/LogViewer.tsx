import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProcessEntry } from '../../config/types';
import { requestApi } from '../../hooks/useProcessConfig';
import './LogViewer.css';

interface LogViewerProps {
  process: ProcessEntry;
  serverLabel: string;
  onClose: () => void;
}

const LINE_OPTIONS = [100, 200, 500, 1000, 2000];
const AUTO_REFRESH_MS = 3000;

/** 프로세스 로그 파일의 끝부분(tail -n)을 보여준다. 자동 새로고침을 켜면 3초마다 다시 읽는다. */
const LogViewer: React.FC<LogViewerProps> = ({ process: target, serverLabel, onClose }) => {
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await requestApi<{ output: string }>(
        `${process.env.PUBLIC_URL}/api/processes/${encodeURIComponent(target.id)}/log?lines=${lines}`
      );
      setOutput(body.output);
      setError(null);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [target.id, lines]);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const timer = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, autoRefresh]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [output, filter]);

  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const lowerFilter = filter.toLowerCase();
  const shownLines = (output ?? '').replace(/\n$/, '').split('\n').filter(line => line.toLowerCase().includes(lowerFilter));

  return (
    <div className="log-viewer-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="log-viewer" role="dialog" aria-modal="true" aria-label="로그 보기">
        <header className="log-viewer-header">
          <div className="log-viewer-title">
            <strong>{target.label || target.id}</strong>
            <span>{serverLabel}</span>
            <code>{target.logFile}</code>
          </div>
          <button className="btn-icon" onClick={onClose} title="닫기 (Esc)">
            ✕
          </button>
        </header>

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
          <input className="input log-viewer-filter" placeholder="이 단어가 있는 줄만 보기" value={filter} onChange={e => setFilter(e.target.value)} />
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
              ? filter ? '일치하는 줄이 없습니다.' : '(비어 있음)'
              : shownLines.join('\n')}
        </pre>
      </div>
    </div>
  );
};

export default LogViewer;
