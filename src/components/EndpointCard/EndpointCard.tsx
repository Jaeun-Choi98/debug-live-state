import React from 'react';
import JsonViewer, { subtreeMatches } from '../JsonViewer/JsonViewer';
import { EndpointConfig } from '../../config/types';
import { useEndpointPoller } from '../../hooks/useEndpointPoller';
import { useNowTick } from '../../hooks/useNowTick';
import './EndpointCard.css';

interface EndpointCardProps {
  config: EndpointConfig;
  filter: string;
}

function formatRelativeTime(date: Date | null, now: number): string {
  if (!date) return '-';
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const EndpointCard: React.FC<EndpointCardProps> = ({ config, filter }) => {
  const poller = useEndpointPoller(config);
  const now = useNowTick(1000);
  const { status, data, error, lastUpdatedAt, latencyMs, paused, togglePaused, refreshNow } = poller;

  const lowerFilter = filter.toLowerCase();
  const metaMatches =
    filter === '' ||
    config.label.toLowerCase().includes(lowerFilter) ||
    config.url.toLowerCase().includes(lowerFilter);
  const dataMatches = filter === '' || subtreeMatches(undefined, data, filter);

  // 로딩 여부는 LOADING 배지로 따로 보여주고, 상태 점은 로딩 중에도 마지막 결과를 유지한다.
  const isLoading = status === 'loading';
  const lastResult = isLoading ? (error !== null ? 'error' : data !== null ? 'ok' : 'loading') : status;

  if (filter !== '' && !metaMatches && !dataMatches) {
    return null;
  }

  return (
    <section className="endpoint-card">
      <header className="endpoint-card-header">
        <div className="endpoint-card-title-row">
          <span className={`status-dot status-${lastResult}`} title={lastResult} />
          <span className="endpoint-card-label">{config.label}</span>
          {isLoading && (
            <span className="endpoint-card-loading-badge">
              <span className="endpoint-card-spinner" />
              LOADING
            </span>
          )}
          {paused && <span className="endpoint-card-paused-badge">PAUSED</span>}
        </div>
        <div className="endpoint-card-actions">
          <button className="btn-icon" onClick={refreshNow} title="지금 새로고침">↻</button>
          <button className="btn-icon" onClick={togglePaused} title={paused ? '재개' : '일시정지'}>
            {paused ? '▶' : '⏸'}
          </button>
        </div>
      </header>

      <div className="endpoint-card-meta">
        <span className="endpoint-card-url" title={config.url}>{config.url}</span>
        <span>every {config.pollIntervalMs}ms</span>
        <span>{formatRelativeTime(lastUpdatedAt, now)}</span>
        {latencyMs !== null && <span className="endpoint-card-latency">{latencyMs.toFixed(0)}ms</span>}
      </div>

      <div className="endpoint-card-body">
        {status === 'idle' && <div className="endpoint-card-placeholder">첫 응답을 기다리는 중...</div>}
        {status === 'loading' && data === null && error === null && (
          <div className="endpoint-card-placeholder">로딩 중...</div>
        )}
        {/* 재시도(loading) 중에도 직전 에러를 계속 보여준다. 성공하면 poller가 error를 null로 비운다. */}
        {error !== null && <div className="endpoint-card-error">{error}</div>}
        {data !== null && (status === 'ok' || status === 'loading' || status === 'error') && (
          <JsonViewer data={data} filter={filter} />
        )}
      </div>
    </section>
  );
};

export default EndpointCard;
