import React from 'react';
import { EndpointConfig } from '../../config/types';
import { groupEndpoints } from '../../config/groups';
import { EndpointStatus } from '../../hooks/useEndpointPoller';
import './StatusSidebar.css';

interface StatusSidebarProps {
  endpoints: EndpointConfig[];
  statuses: Record<string, EndpointStatus>;
  /** 클릭한 카드(또는 그룹)의 DOM id 를 넘긴다. */
  onSelect: (domId: string) => void;
}

const STATUS_TEXT: Record<EndpointStatus, string> = { ok: '정상', error: '오류', loading: '대기', idle: '대기' };

/**
 * 엔드포인트별 상태를 초록/빨강 점으로 한눈에 보여주고, 클릭하면 해당 카드(그룹)로 이동한다.
 * 첫 응답 전(대기)은 회색 점이다. 순서는 설정 파일 순서를 따른다.
 */
const StatusSidebar: React.FC<StatusSidebarProps> = ({ endpoints, statuses, onSelect }) => {
  const countOf = (list: EndpointConfig[], status: EndpointStatus) => list.filter(e => statuses[e.id] === status).length;

  return (
    <aside className="status-sidebar">
      <div className="status-sidebar-summary">
        <span className="status-sidebar-count status-sidebar-count-ok">정상 {countOf(endpoints, 'ok')}</span>
        <span className="status-sidebar-count status-sidebar-count-error">오류 {countOf(endpoints, 'error')}</span>
        <span className="status-sidebar-count">전체 {endpoints.length}</span>
      </div>

      {groupEndpoints(endpoints).map(group => {
        // 그룹 점: 하나라도 오류면 빨강, 모두 정상이면 초록, 그 외(응답 전 포함)는 회색
        const errorCount = countOf(group.endpoints, 'error');
        const allOk = countOf(group.endpoints, 'ok') === group.endpoints.length;
        const groupStatus = errorCount > 0 ? 'error' : allOk ? 'ok' : 'idle';

        return (
          <section key={group.name} className={group.name ? 'status-sidebar-group' : undefined}>
            {group.name && (
              <button
                type="button"
                className="status-sidebar-group-header"
                onClick={() => onSelect(`endpoint-group-${group.name}`)}
                title={`${group.name} (${group.endpoints.length}개)`}
              >
                <span className={`status-dot status-${groupStatus}`} />
                <span className="status-sidebar-group-name">{group.name}</span>
                {errorCount > 0 && <span className="status-sidebar-group-errors">{errorCount}</span>}
              </button>
            )}

            <ul className="status-sidebar-list">
              {group.endpoints.map(config => {
                const status = statuses[config.id] ?? 'idle';
                return (
                  <li key={config.id}>
                    <button
                      type="button"
                      className={`status-sidebar-item status-sidebar-item-${status}`}
                      onClick={() => onSelect(`endpoint-card-${config.id}`)}
                      title={`${STATUS_TEXT[status]} · ${config.url}`}
                    >
                      <span className={`status-dot status-${status === 'loading' ? 'idle' : status}`} />
                      <span className="status-sidebar-label">{config.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </aside>
  );
};

export default StatusSidebar;
