import React, { useEffect } from 'react';
import JsonViewer, { subtreeMatches } from '../JsonViewer/JsonViewer';
import { EndpointConfig } from '../../config/types';
import { EndpointStatus, useEndpointPoller } from '../../hooks/useEndpointPoller';
import { useNowTick } from '../../hooks/useNowTick';
import './EndpointCard.css';

interface EndpointCardProps {
  config: EndpointConfig;
  filter: string;
  /** 상태 점에 표시되는 마지막 결과가 바뀔 때 호출된다. (사이드바 표시용) */
  onStatusChange?: (id: string, status: EndpointStatus) => void;
}

const EndpointCard: React.FC<EndpointCardProps> = ({ config, filter, onStatusChange }) => {
  const { status, data, error, lastUpdatedAt, latencyMs, paused, togglePaused, refreshNow } = useEndpointPoller(config);
  const now = useNowTick(1000);

  // 로딩 중인지는 LOADING 배지로 따로 보여주고, 상태 점은 로딩 중에도 마지막 결과를 유지한다.
  const isLoading = status === 'loading';
  const lastResult: EndpointStatus = isLoading ? (error !== null ? 'error' : data !== null ? 'ok' : 'loading') : status;

  // 검색에 가려져도(아래 return null) 폴링은 계속되므로 상태는 계속 알린다.
  useEffect(() => {
    onStatusChange?.(config.id, lastResult);
  }, [config.id, lastResult, onStatusChange]);

  // 검색: 이름/그룹/URL 로 걸리면 JSON 을 거르지 않고 전체를, JSON 내용으로 걸리면 일치하는 부분만 보여준다.
  const lowerFilter = filter.toLowerCase();
  const metaMatches = [config.label, config.group, config.url].some(text => text.toLowerCase().includes(lowerFilter));
  const dataMatches = filter === '' || subtreeMatches(undefined, data, filter);
  if (!metaMatches && !dataMatches) return null;

  const secondsAgo = lastUpdatedAt ? Math.max(0, Math.floor((now - lastUpdatedAt.getTime()) / 1000)) : null;
  const updatedAgo =
    secondsAgo === null ? '-'
    : secondsAgo < 1 ? 'just now'
    : secondsAgo < 60 ? `${secondsAgo}s ago`
    : secondsAgo < 3600 ? `${Math.floor(secondsAgo / 60)}m ago`
    : `${Math.floor(secondsAgo / 3600)}h ago`;

  return (
    <section className="endpoint-card" id={`endpoint-card-${config.id}`} tabIndex={-1}>
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
          <button className="btn-icon" onClick={refreshNow} title="지금 새로고침">
            ↻
          </button>
          <button className="btn-icon" onClick={togglePaused} title={paused ? '재개' : '일시정지'}>
            {paused ? '▶' : '⏸'}
          </button>
        </div>
      </header>

      <div className="endpoint-card-meta">
        <span className="endpoint-card-url" title={config.url}>
          {config.url}
        </span>
        <span>every {config.pollIntervalMs}ms</span>
        <span>{updatedAgo}</span>
        {latencyMs !== null && <span className="endpoint-card-latency">{latencyMs.toFixed(0)}ms</span>}
      </div>

      <div className="endpoint-card-body">
        {data === null && error === null && (
          <div className="endpoint-card-placeholder">{status === 'idle' ? '첫 응답을 기다리는 중...' : '로딩 중...'}</div>
        )}
        {/* 재시도(loading) 중에도 직전 에러를 계속 보여준다. 성공하면 poller 가 error 를 비운다. */}
        {error !== null && <div className="endpoint-card-error">{error}</div>}
        {data !== null && <JsonViewer data={data} filter={dataMatches ? filter : ''} />}
      </div>
    </section>
  );
};

export default EndpointCard;
