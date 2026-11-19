import React, { useCallback, useEffect, useState } from 'react';
import './App.css';
import Dashboard from './pages/Dashboard';

/**
 * 경로 라우팅: /all 은 전체 그룹, /uw 처럼 그룹 slug 경로는 그 그룹만 보여준다. ( / 는 /all 로 이동 )
 * Go 서버는 확장자 없는 경로를 모두 index.html 로 돌려주므로 새로고침 · 주소 직접 입력도 된다.
 */
function App(): React.ReactElement {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    setPathname(to);
    window.scrollTo(0, 0);
  }, []);

  const slug = decodeURIComponent(pathname.split('/')[1] ?? '') || 'all';
  useEffect(() => {
    if (pathname === '/') window.history.replaceState(null, '', '/all');
  }, [pathname]);

  return (
    <div className="App">
      <Dashboard slug={slug} navigate={navigate} />
    </div>
  );
}

export default App;
