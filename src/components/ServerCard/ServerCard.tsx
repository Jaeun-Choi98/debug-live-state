import React, { useState } from 'react';
import { ProcessEntry, ServerEntry, ServerStatus } from '../../config/types';
import { ServerState } from '../StatusSidebar/StatusSidebar';
import { requestApi } from '../../hooks/useProcessConfig';
import './ServerCard.css';

interface ServerCardProps {
  server: ServerEntry;
  /** 이 서버의 프로세스 (검색으로 걸러진 목록) */
  processes: ProcessEntry[];
  /** 아직 한 번도 확인하지 않았으면 undefined */
  status: ServerStatus | undefined;
  /** 상태 점 색 (사이드바와 같은 값) */
  state: ServerState;
  onShowLog: (process: ProcessEntry) => void;
  /** 시작 · 중지가 끝나면 호출한다. (상태 새로고침) */
  onActionDone: () => void;
}

/** 아래에서 process 를 프로세스 항목 이름으로 쓰므로 환경 변수는 여기서 읽어 둔다. */
const PROCESSES_API = `${process.env.PUBLIC_URL}/api/processes`;

type Action = 'start' | 'stop' | 'restart';
const ACTION_TEXT: Record<Action, string> = { start: '시작', stop: '중지', restart: '재시작' };

/** 서버 하나의 SSH 접속 상태와, 그 서버에서 확인한 프로세스별 실행 상태 · 로그 · 시작/중지 버튼 */
const ServerCard: React.FC<ServerCardProps> = ({ server, processes, status, state: serverState, onShowLog, onActionDone }) => {
  /** 프로세스 id → 진행 중인 동작 */
  const [busy, setBusy] = useState<Record<string, Action>>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const runAction = async (process: ProcessEntry, action: Action) => {
    const name = process.label || process.id;
    if (action !== 'start' && !window.confirm(`${server.label || server.id} 의 ${name} 을(를) ${ACTION_TEXT[action]}할까요?`)) return;

    setBusy(prev => ({ ...prev, [process.id]: action }));
    setMessage(null);
    try {
      const result = await requestApi<{ message: string }>(
        `${PROCESSES_API}/${encodeURIComponent(process.id)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
      setMessage({ kind: 'info', text: `${name}: ${result.message}` });
    } catch (e) {
      setMessage({ kind: 'error', text: `${name} ${ACTION_TEXT[action]} 실패: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(({ [process.id]: _, ...rest }) => rest);
      onActionDone();
    }
  };

  const runningCount = processes.filter(p => status?.processes.find(s => s.id === p.id)?.instances.length).length;

  return (
    <section className="server-card" id={`server-card-${server.id}`} tabIndex={-1}>
      <header className="server-card-header">
        <span className={`status-dot status-${serverState}`} />
        <span className="server-card-label">{server.label || server.id}</span>
        <span className="server-card-host" title={`ssh ${server.user}@${server.host}:${server.port ?? 22}`}>
          {server.user}@{server.host}
          {server.port && server.port !== 22 ? `:${server.port}` : ''}
        </span>
        <span className="server-card-summary">
          {status && !status.error && `실행 ${runningCount}/${processes.length}`}
        </span>
      </header>

      {status?.error && <div className="server-card-error">{status.error}</div>}
      {message && <div className={`server-card-message server-card-message-${message.kind}`}>{message.text}</div>}

      {processes.length === 0 ? (
        <div className="server-card-placeholder">등록된 프로세스가 없습니다.</div>
      ) : (
        <table className="server-card-table">
          <thead>
            <tr>
              <th>프로세스</th>
              <th>PID</th>
              <th className="server-card-num">CPU</th>
              <th className="server-card-num">MEM</th>
              <th>실행 시간</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {processes.map(process => {
              const instances = status?.processes.find(s => s.id === process.id)?.instances ?? [];
              const running = instances.length > 0;
              // 접속 실패 · 첫 확인 전에는 실행 여부를 알 수 없다.
              const known = status !== undefined && !status.error;
              const state = !known ? 'idle' : running ? 'ok' : 'error';
              const action = busy[process.id];

              return (
                <tr key={process.id} className={`server-card-row-${state}`}>
                  <td>
                    <div className="server-card-process" title={`match: ${process.match}`}>
                      <span className={`status-dot status-${action ? 'loading' : state}`} />
                      <span className="server-card-process-name">{process.label || process.id}</span>
                      {known && !running && <span className="server-card-badge">STOPPED</span>}
                    </div>
                  </td>
                  <td className="server-card-mono" title={instances.map(i => `${i.pid}: ${i.command}`).join('\n')}>
                    {running ? instances.map(i => i.pid).join(', ') : '-'}
                  </td>
                  <td className="server-card-num">{running ? `${instances.reduce((sum, i) => sum + i.cpu, 0).toFixed(1)}%` : '-'}</td>
                  <td className="server-card-num">{running ? `${instances.reduce((sum, i) => sum + i.mem, 0).toFixed(1)}%` : '-'}</td>
                  <td className="server-card-mono">{running ? instances[0].elapsed : '-'}</td>
                  <td>
                    <div className="server-card-actions">
                      {action ? (
                        <span className="server-card-busy">{ACTION_TEXT[action]} 중...</span>
                      ) : (
                        <>
                          <button className="btn-text" onClick={() => onShowLog(process)} disabled={!process.logFile} title={process.logFile || '로그 파일이 등록되지 않았습니다'}>
                            로그
                          </button>
                          {known && !running && (
                            <button className="btn-text btn-text-ok" onClick={() => runAction(process, 'start')} disabled={!process.startScript} title={process.startScript || '시작 스크립트가 등록되지 않았습니다'}>
                              시작
                            </button>
                          )}
                          {known && running && (
                            <>
                              <button className="btn-text" onClick={() => runAction(process, 'restart')} disabled={!process.startScript} title={process.startScript || '시작 스크립트가 등록되지 않았습니다'}>
                                재시작
                              </button>
                              <button className="btn-text btn-text-danger" onClick={() => runAction(process, 'stop')} title={`PID ${instances.map(i => i.pid).join(' ')} 에 SIGTERM`}>
                                중지
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
};

export default ServerCard;
