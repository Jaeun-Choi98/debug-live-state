import React from 'react';
import { GroupEntry } from '../../config/types';
import './Header.css';

interface HeaderProps {
  groups: GroupEntry[];
  /** 지금 보고 있는 그룹 slug ("all" 이면 전체) */
  currentSlug: string;
  navigate: (to: string) => void;
}

/**
 * 상단 바: 그룹 탭으로 화면을 바꾼다.
 *   /all          전체 + 모든 그룹 탭
 *   /uw (그룹)    그 그룹 탭만 (다른 그룹으로 가는 탭을 보여주지 않는다. 로고도 그 그룹으로 간다)
 *   없는 그룹     전체 + 모든 그룹 탭 (돌아갈 곳을 고를 수 있게)
 */
const Header: React.FC<HeaderProps> = ({ groups, currentSlug, navigate }) => {
  const currentGroup = groups.find(g => g.slug === currentSlug);
  const tabs = currentGroup ? [currentGroup] : [{ slug: 'all', name: '전체' }, ...groups];
  const home = currentGroup ? `/${currentGroup.slug}` : '/all';

  return (
    <nav className="navbar">
      <a className="navbar-brand" href={home} onClick={e => { e.preventDefault(); navigate(home); }}>
        <span className="navbar-brand-icon">&#9678;</span>
        Process Management
      </a>
      <div className="navbar-tabs">
        {tabs.map(tab => (
          <a
            key={tab.slug}
            className={`navbar-tab${tab.slug === currentSlug ? ' navbar-tab-active' : ''}`}
            href={`/${tab.slug}`}
            aria-current={tab.slug === currentSlug ? 'page' : undefined}
            onClick={e => {
              // Ctrl · Cmd · 가운데 클릭은 브라우저 기본 동작(새 탭)에 맡긴다.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              navigate(`/${tab.slug}`);
            }}
          >
            {tab.name}
          </a>
        ))}
      </div>
    </nav>
  );
};

export default Header;
