import React, { useEffect, useState } from 'react';
import { ProcessConfig, ProcessEntry, ProcessInstance, WatchStatus } from '../../config/types';
import { requestApi } from '../../hooks/useProcessConfig';
import './WatchEditor.css';

interface WatchEditorProps {
  process: ProcessEntry;
  serverLabel: string;
  /** 지금 감시 상태 (감시 조건이 없거나 확인 전이면 undefined) */
  watch: WatchStatus | undefined;
  /** 저장에 성공하면 서버가 돌려준 전체 설정으로 화면을 갱신한다. */
  onSaved: (config: ProcessConfig) => void;
  onClose: () => void;
}

/** 아래에서 process 를 프로세스 항목 이름으로 쓰므로 환경 변수는 여기서 읽어 둔다. */
const PROCESSES_API = `${process.env.PUBLIC_URL}/api/processes`;

/**
 * 모니터링 화면에서 프로세스 하나의 자동 재시작 · 감시 조건을 바꾼다.
 * '확인' 으로 지금 서버의 ps 에서 조건에 맞는 프로세스를 미리 보고 저장할 수 있다.
 */
const WatchEditor: React.FC<WatchEditorProps> = ({ process: target, serverLabel, watch, onSaved, onClose }) => {
  const [autoRestart, setAutoRestart] = useState(Boolean(target.autoRestart));
  const [watchName, setWatchName] = useState(target.watchName ?? '');
  const [watchArgs, setWatchArgs] = useState(target.watchArgs ?? '');
  /** '확인' 결과. 조건을 바꾸면 지운다. */
  const [found, setFound] = useState<ProcessInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasCondition = watchName.trim() !== '' || watchArgs.trim() !== '';
  const base = `${PROCESSES_API}/${encodeURIComponent(target.id)}`;

  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = `name=${encodeURIComponent(watchName.trim())}&args=${encodeURIComponent(watchArgs.trim())}`;
      setFound((await requestApi<{ instances: ProcessInstance[] }>(`${base}/watch-test?${query}`)).instances);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await requestApi<ProcessConfig>(`${base}/watch`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoRestart, watchName: watchName.trim(), watchArgs: watchArgs.trim() }),
        })
      );
      onClose();
    } catch (e) {
      setError(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  const changeCondition = (setter: (value: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value);
    setFound(null);
  };

  return (
    <div className="watch-editor-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="watch-editor" role="dialog" aria-modal="true" aria-label="자동 재시작 설정">
        <header className="watch-editor-header">
          <div>
            <strong>{target.label || target.id}</strong>
            <span>{serverLabel}</span>
          </div>
          <button className="btn-icon" onClick={onClose} title="닫기 (Esc)">
            ✕
          </button>
        </header>

        <div className="watch-editor-body">
          {watch && (
            <div className="watch-editor-status">
              지금: 감시 프로세스 {watch.healthy ? '있음' : '없음'} · 자동 시작 {watch.restarts}회
              {watch.lastRestartAt && ` (마지막 ${new Date(watch.lastRestartAt).toLocaleString()})`}
              {watch.paused && ' · 화면에서 중지해 멈춘 상태 (시작 · 재시작하면 다시 켜집니다)'}
              {watch.lastError && <div className="watch-editor-error-text">오류: {watch.lastError}</div>}
            </div>
          )}

          <label className="watch-editor-check">
            <input type="checkbox" checked={autoRestart} onChange={e => setAutoRestart(e.target.checked)} />
            자동 재시작 — 감시 프로세스가 없으면 시작 스크립트를 실행합니다
          </label>
          {autoRestart && !target.startScript && (
            <div className="watch-editor-warn">시작 스크립트가 등록되지 않았습니다. ⚙ 설정에서 먼저 등록하세요.</div>
          )}

          <label className="watch-editor-field">
            <span>감시 문자열</span>
            <input
              className="input"
              placeholder="-jar /opt/app/app.jar"
              value={watchArgs}
              onChange={changeCondition(setWatchArgs)}
              autoFocus
            />
            <small>ps 명령줄에 들어 있어야 하는 글자 (정규식 아님). 이 프로세스만 가진 글자로 적으세요.</small>
          </label>
          <label className="watch-editor-field">
            <span>감시 이름 (선택)</span>
            <input className="input" placeholder="java" value={watchName} onChange={changeCondition(setWatchName)} />
            <small>실행 파일 이름. 적으면 명령줄 첫 단어의 파일 이름이 정확히 같아야 합니다.</small>
          </label>

          <div className="watch-editor-test">
            <button className="btn btn-secondary" onClick={test} disabled={!hasCondition || busy}>
              지금 맞는 프로세스 확인
            </button>
            {found && (
              <span className={found.length === 1 ? 'watch-editor-ok-text' : 'watch-editor-warn-text'}>
                {found.length === 0 ? '맞는 프로세스가 없습니다' : `${found.length}개`}
                {found.length > 1 && ' — 여러 개가 맞습니다. 다른 프로세스가 섞이지 않았는지 보세요'}
              </span>
            )}
          </div>
          {found && found.length > 0 && (
            <ul className="watch-editor-found">
              {found.map(instance => (
                <li key={instance.pid} title={instance.command}>
                  <code>{instance.pid}</code> {instance.command}
                </li>
              ))}
            </ul>
          )}

          {error && <div className="watch-editor-error">{error}</div>}
        </div>

        <footer className="watch-editor-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            취소
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || (autoRestart && !hasCondition)}>
            저장
          </button>
        </footer>
      </div>
    </div>
  );
};

export default WatchEditor;
