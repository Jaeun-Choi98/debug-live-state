import React, { useCallback, useEffect, useState } from 'react';
import Header from '../components/Header/Header';
import ConfigEditor from '../components/ConfigEditor/ConfigEditor';
import EndpointCard from '../components/EndpointCard/EndpointCard';
import MarkdownPanel from '../components/MarkdownPanel/MarkdownPanel';
import StatusSidebar from '../components/StatusSidebar/StatusSidebar';
import { groupEndpoints } from '../config/groups';
import { useEndpointsConfig } from '../hooks/useEndpointsConfig';
import { EndpointStatus } from '../hooks/useEndpointPoller';
import './Dashboard.css';

const FOCUSED_CLASS = 'endpoint-card-focused';

const Dashboard: React.FC = () => {
  const { file, endpoints, editable, loading, error, reload, save } = useEndpointsConfig();
  const [filter, setFilter] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  /** 엔드포인트 id → 상태 (사이드바 표시용, 각 카드가 알려준다) */
  const [statuses, setStatuses] = useState<Record<string, EndpointStatus>>({});
  /** 검색에 가려진 카드를 골랐을 때, 검색을 지우고 다시 그려진 뒤 스크롤할 대상 */
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);

  const handleStatusChange = useCallback((id: string, status: EndpointStatus) => {
    setStatuses(prev => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }, []);

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  /**
   * 사이드바에서 고른 카드(또는 그룹 제목)로 스크롤한다. 카드는 잠깐 강조한다.
   * 검색으로 숨겨져 있으면(카드는 그려지지 않고, 빈 그룹은 display: none) 검색을 지우고 다시 시도한다.
   */
  const scrollToElement = useCallback((domId: string, clearFilterIfHidden = true) => {
    const el = document.getElementById(domId);
    if (!el || el.offsetParent === null) {
      if (clearFilterIfHidden) {
        setFilter('');
        setPendingScrollId(domId);
      }
      return;
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!el.classList.contains('endpoint-card')) return;

    el.focus({ preventScroll: true });
    // 같은 카드를 연달아 눌러도 애니메이션이 다시 재생되도록 클래스를 뗐다 붙인다.
    el.classList.remove(FOCUSED_CLASS);
    void el.offsetWidth;
    el.classList.add(FOCUSED_CLASS);
    el.addEventListener('animationend', () => el.classList.remove(FOCUSED_CLASS), { once: true });
  }, []);

  useEffect(() => {
    if (pendingScrollId === null) return;
    setPendingScrollId(null);
    scrollToElement(pendingScrollId, false);
  }, [pendingScrollId, scrollToElement]);

  return (
    <div>
      <Header />
      <div className="page">
        <div className="dashboard-layout">
          {endpoints.length > 0 && (
            <StatusSidebar endpoints={endpoints} statuses={statuses} onSelect={scrollToElement} />
          )}

          <div className="dashboard-main">
            <div className="dashboard-toolbar">
              <h1 className="page-title dashboard-title">Debug Dashboard</h1>
              <div className="dashboard-toolbar-actions">
                <input
                  className="input dashboard-search"
                  type="text"
                  placeholder="key / value / 엔드포인트 검색..."
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                />
                <button className="btn btn-secondary" onClick={() => setEditorOpen(true)} disabled={file === null}>
                  ⚙ 설정
                </button>
                <button className="btn btn-primary" onClick={reload} disabled={loading}>
                  {loading ? '로딩...' : '↻ Reload Config'}
                </button>
              </div>
            </div>

            <MarkdownPanel file="README.md" title="📖 소개 · 사용 방법" defaultOpen />
            <MarkdownPanel file="API.md" title="🔌 API 명세 (프론트 · 백엔드)" defaultOpen={false} />

            {error && <div className="api-error">{error}</div>}

            {!loading && !error && endpoints.length === 0 && (
              <div className="dashboard-empty">등록된 API가 없습니다. ⚙ 설정에서 엔드포인트를 추가해주세요.</div>
            )}

            {groupEndpoints(endpoints).map(group => (
              <section key={group.name} className="endpoint-group" id={`endpoint-group-${group.name}`}>
                {group.name && (
                  <h2 className="endpoint-group-title">
                    {group.name}
                    <span className="endpoint-group-count">{group.endpoints.length}</span>
                  </h2>
                )}
                <div className="endpoint-grid">
                  {group.endpoints.map(config => (
                    <EndpointCard key={config.id} config={config} filter={filter} onStatusChange={handleStatusChange} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {editorOpen && file && <ConfigEditor file={file} editable={editable} onSave={save} onClose={closeEditor} />}
    </div>
  );
};

export default Dashboard;
