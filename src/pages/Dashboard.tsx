import React, { useState } from 'react';
import Header from '../components/Header/Header';
import EndpointCard from '../components/EndpointCard/EndpointCard';
import { useEndpointsConfig } from '../hooks/useEndpointsConfig';
import './Dashboard.css';

const Dashboard: React.FC = () => {
  const { endpoints, loading, error, reload } = useEndpointsConfig();
  const [filter, setFilter] = useState('');

  return (
    <div>
      <Header />
      <div className="page">
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
            <button className="btn btn-primary" onClick={reload} disabled={loading}>
              {loading ? '로딩...' : '↻ Reload Config'}
            </button>
          </div>
        </div>

        {error && <div className="api-error">{error}</div>}

        {!loading && !error && endpoints.length === 0 && (
          <div className="dashboard-empty">
            등록된 API가 없습니다. <code>public/config/endpoints.ini</code> 에 엔드포인트를 추가한 뒤
            Reload Config를 눌러주세요.
          </div>
        )}

        <div className="endpoint-grid">
          {endpoints.map(config => (
            <EndpointCard key={config.id} config={config} filter={filter} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
