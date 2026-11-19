import React from 'react';
import { GroupEntry, ProcessEntry, ServerEntry, ServerStatus } from '../../config/types';
import './StatusSidebar.css';

/** 상태 점 색. ok 초록, warn 주황(일부 중지), error 빨강(접속 실패 · 모두 중지), idle 회색(확인 전) */
export type ServerState = 'ok' | 'warn' | 'error' | 'idle';

/** Dashboard 가 만든 서버 하나의 화면 정보 */
export interface ServerView {
  server: ServerEntry;
  processes: ProcessEntry[];
  status: ServerStatus | undefined;
  /** 중지된 프로세스 수 */
  stopped: number;
  state: ServerState;
}

interface StatusSidebarProps {
  view: { group: GroupEntry; servers: ServerView[] }[];
  /** 클릭한 서버 카드(또는 그룹)의 DOM id 를 넘긴다. */
  onSelect: (domId: string) => void;
}

/**
 * 서버별 상태를 점 색으로 한눈에 보여주고, 클릭하면 해당 서버 카드(그룹)로 이동한다.
 * 순서는 설정 파일 순서를 따른다.
 */
const StatusSidebar: React.FC<StatusSidebarProps> = ({ view, onSelect }) => {
  const servers = view.flatMap(v => v.servers);
  const processCount = servers.reduce((sum, s) => sum + s.processes.length, 0);
  const stoppedCount = servers.reduce((sum, s) => sum + s.stopped, 0);
  const unreachable = servers.filter(s => s.status?.error).length;

  return (
    <aside className="status-sidebar">
      <div className="status-sidebar-summary">
        <span className="status-sidebar-count">프로세스 {processCount}</span>
        <span className={`status-sidebar-count${stoppedCount > 0 ? ' status-sidebar-count-error' : ''}`}>중지 {stoppedCount}</span>
        <span className={`status-sidebar-count${unreachable > 0 ? ' status-sidebar-count-error' : ''}`}>접속 실패 {unreachable}</span>
      </div>

      {view.map(({ group, servers: groupServers }) => {
        // 그룹 점: 하나라도 빨강이면 빨강, 주황이 있으면 주황, 모두 초록이면 초록, 그 외(확인 전 포함)는 회색
        const states = groupServers.map(s => s.state);
        const groupState: ServerState =
          states.includes('error') ? 'error'
          : states.includes('warn') ? 'warn'
          : states.length > 0 && states.every(s => s === 'ok') ? 'ok'
          : 'idle';
        const problems = groupServers.filter(s => s.state === 'error' || s.state === 'warn').length;

        return (
          <section key={group.slug} className="status-sidebar-group">
            <button
              type="button"
              className="status-sidebar-group-header"
              onClick={() => onSelect(`server-group-${group.slug}`)}
              title={`${group.name} (서버 ${groupServers.length}대)`}
            >
              <span className={`status-dot status-${groupState}`} />
              <span className="status-sidebar-group-name">{group.name}</span>
              {problems > 0 && <span className="status-sidebar-group-errors">{problems}</span>}
            </button>

            <ul className="status-sidebar-list">
              {groupServers.map(({ server, status, stopped, state }) => (
                <li key={server.id}>
                  <button
                    type="button"
                    className={`status-sidebar-item status-sidebar-item-${state}`}
                    onClick={() => onSelect(`server-card-${server.id}`)}
                    title={
                      !status ? '확인 중' : status.error ? `접속 실패: ${status.error}` : stopped > 0 ? `중지된 프로세스 ${stopped}개` : '모두 실행 중'
                    }
                  >
                    <span className={`status-dot status-${state}`} />
                    <span className="status-sidebar-label">{server.label || server.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
};

export default StatusSidebar;
