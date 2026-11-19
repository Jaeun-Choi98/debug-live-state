import React from 'react';
import { GroupEntry } from '../../config/types';
import './Header.css';

interface HeaderProps {
  groups: GroupEntry[];
  /** 지금 보고 있는 그룹 slug ("all" 이면 전체) */
  currentSlug: string;
  navigate: (to: string) => void;
}

/** 상단 바: 그룹 탭(/all, /uw ...)으로 화면을 바꾼다. */
const Header: React.FC<HeaderProps> = ({ groups, currentSlug, navigate }) => {
  const tabs = [{ slug: 'all', name: '전체' }, ...groups];

  return (
    <nav className="navbar">
      <a className="navbar-brand" href="/all" onClick={e => { e.preventDefault(); navigate('/all'); }}>
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
