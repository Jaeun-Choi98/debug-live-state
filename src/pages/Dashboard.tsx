import React, { useCallback, useEffect, useState } from 'react';
import Header from '../components/Header/Header';
import ConfigEditor from '../components/ConfigEditor/ConfigEditor';
import LogViewer, { FileRoot } from '../components/LogViewer/LogViewer';
import WatchEditor from '../components/WatchEditor/WatchEditor';
import MarkdownPanel from '../components/MarkdownPanel/MarkdownPanel';
import ServerCard from '../components/ServerCard/ServerCard';
import StatusSidebar, { ServerView } from '../components/StatusSidebar/StatusSidebar';
import { DEFAULT_POLL_INTERVAL_MS } from '../config/schema';
import { GroupEntry, ProcessEntry, WatchStatus } from '../config/types';
import { useGroupStatus } from '../hooks/useGroupStatus';
import { useProcessConfig } from '../hooks/useProcessConfig';
import './Dashboard.css';

const FOCUSED_CLASS = 'card-focused';

interface DashboardProps {
  /** URL 의 그룹 slug. "all" 이면 전체 그룹 */
  slug: string;
  navigate: (to: string) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ slug, navigate }) => {
  const { config, loading, error, reload, refresh, save, apply } = useProcessConfig();
  const [filter, setFilter] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  /** 열려 있는 로그 · INI 파일 목록 창 */
  const [fileTarget, setFileTarget] = useState<{ process: ProcessEntry; serverLabel: string; root: FileRoot } | null>(null);
  /** 열려 있는 자동 재시작 · 감시 조건 창 */
  const [watchTarget, setWatchTarget] = useState<{ process: ProcessEntry; serverLabel: string; watch: WatchStatus | undefined } | null>(null);
  /** 검색에 가려진 카드를 골랐을 때, 검색을 지우고 다시 그려진 뒤 스크롤할 대상 */
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);

  const groups: GroupEntry[] = config?.groups ?? [];
  const currentGroup = groups.find(g => g.slug === slug);
  const slugExists = slug === 'all' || currentGroup !== undefined;
  const status = useGroupStatus(slug, config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, config !== null && slugExists);

  // 화면 구조: 그룹 → 서버 → 프로세스. 서버 상태 점은 사이드바와 카드가 같이 쓴다.
  //   빨강: SSH 접속 실패 또는 프로세스가 모두 중지 / 주황: 일부 중지 / 초록: 모두 실행 중 / 회색: 확인 전
  const view: { group: GroupEntry; servers: ServerView[] }[] = (slug === 'all' ? groups : groups.filter(g => g.slug === slug)).map(group => ({
    group,
    servers: (config?.servers ?? [])
      .filter(server => server.group === group.slug)
      .map(server => {
        const processes = (config?.processes ?? []).filter(p => p.server === server.id);
        const serverStatus = status.servers[server.id];
        const stopped =
          serverStatus && !serverStatus.error
            ? processes.filter(p => !serverStatus.processes.find(s => s.id === p.id)?.instances.length).length
            : 0;
        const state =
          !serverStatus ? 'idle'
          : serverStatus.error || (stopped > 0 && stopped === processes.length) ? 'error'
          : stopped > 0 ? 'warn'
          : 'ok';
        return { server, processes, status: serverStatus, stopped, state };
      }),
  }));

  const closeEditor = useCallback(() => setEditorOpen(false), []);
  /**
   * 설정 창은 최신 설정을 읽은 뒤 연다. 다른 사용자 · 다른 탭이 바꾼 내용 위에서 편집해야
   * 저장할 때 '그 사이 바뀌었다(409)' 로 막히지 않는다. 읽지 못하면 지금 화면의 설정으로 연다.
   */
  const openEditor = async () => {
    try {
      await refresh();
    } catch {
      // 저장할 때 서버가 다시 확인한다.
    }
    setEditorOpen(true);
  };
  const closeFiles = useCallback(() => setFileTarget(null), []);
  const closeWatch = useCallback(() => setWatchTarget(null), []);

  // 다른 그룹으로 이동하면 검색을 지운다.
  useEffect(() => setFilter(''), [slug]);

  /**
   * 사이드바에서 고른 서버 카드(또는 그룹 제목)로 스크롤한다. 카드는 잠깐 강조한다.
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
    if (!el.classList.contains('server-card')) return;

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

  const lowerFilter = filter.toLowerCase();
  const matches = (...texts: (string | undefined)[]) => texts.some(text => text?.toLowerCase().includes(lowerFilter));

  return (
    <div>
      <Header groups={groups} currentSlug={slug} navigate={navigate} />
      <div className="page">
        <div className="dashboard-layout">
          {view.some(v => v.servers.length > 0) && <StatusSidebar view={view} onSelect={scrollToElement} />}

          <div className="dashboard-main">
            <div className="dashboard-toolbar">
              <h1 className="page-title dashboard-title">{slug === 'all' ? '전체' : (currentGroup?.name ?? slug)}</h1>
              <div className="dashboard-toolbar-actions">
                <input
                  className="input dashboard-search"
                  type="text"
                  placeholder="서버 / 호스트 / 프로세스 검색..."
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                />
                <button className="btn btn-secondary" onClick={openEditor} disabled={config === null}>
                  ⚙ 설정
                </button>
                <button className="btn btn-primary" onClick={status.refresh} disabled={config === null || !slugExists}>
                  {status.loading ? '확인 중...' : '↻ 새로고침'}
                </button>
              </div>
            </div>

            <MarkdownPanel file="README.md" title="📖 소개 · 사용 방법" defaultOpen />
            <MarkdownPanel file="API.md" title="🔌 API 명세 (프론트 · 백엔드)" defaultOpen={false} />

            {error && (
              <div className="api-error">
                {error}{' '}
                <button className="btn btn-secondary" onClick={reload}>
                  다시 시도
                </button>
              </div>
            )}
            {status.error && <div className="api-error">{status.error}</div>}

            {config && !slugExists && (
              <div className="dashboard-empty">
                '{slug}' 그룹이 없습니다.{' '}
                <a href="/all" onClick={e => { e.preventDefault(); navigate('/all'); }}>
                  전체 보기
                </a>
              </div>
            )}
            {!loading && config && slugExists && view.every(v => v.servers.length === 0) && (
              <div className="dashboard-empty">등록된 서버가 없습니다. ⚙ 설정에서 그룹 · 서버 · 프로세스를 추가하세요.</div>
            )}

            {view.map(({ group, servers }) => (
              <section key={group.slug} className="server-group" id={`server-group-${group.slug}`}>
                {slug === 'all' && (
                  <h2 className="server-group-title">
                    <a href={`/${group.slug}`} onClick={e => { e.preventDefault(); navigate(`/${group.slug}`); }}>
                      {group.name}
                    </a>
                    <span className="server-group-count">{servers.length}</span>
                  </h2>
                )}
                <div className={`server-grid${slug === 'all' ? '' : ' server-grid-wide'}`}>
                  {servers.map(({ server, processes, status: serverStatus, state }) => {
                    // 검색: 그룹 · 서버로 걸리면 프로세스를 모두, 프로세스로 걸리면 일치하는 프로세스만 보여준다.
                    const serverMatches = matches(group.name, server.id, server.label, server.host);
                    const shown = serverMatches ? processes : processes.filter(p => matches(p.id, p.label, p.match));
                    if (!serverMatches && shown.length === 0) return null;
                    return (
                      <ServerCard
                        key={server.id}
                        server={server}
                        processes={shown}
                        status={serverStatus}
                        state={state}
                        onOpenFiles={(process, root) => setFileTarget({ process, serverLabel: server.label || server.id, root })}
                        onEditWatch={(process, watch) => setWatchTarget({ process, serverLabel: server.label || server.id, watch })}
                        onActionDone={status.refresh}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {editorOpen && config && <ConfigEditor config={config} scope={slugExists ? slug : 'all'} onSave={save} onClose={closeEditor} />}
      {fileTarget && (
        <LogViewer process={fileTarget.process} serverLabel={fileTarget.serverLabel} root={fileTarget.root} onClose={closeFiles} />
      )}
      {watchTarget && (
        <WatchEditor
          process={watchTarget.process}
          serverLabel={watchTarget.serverLabel}
          watch={watchTarget.watch}
          onSaved={next => {
            apply(next);
            status.refresh();
          }}
          onClose={closeWatch}
        />
      )}
    </div>
  );
};

export default Dashboard;
