// npm start(개발 서버)에서 /api 요청을 Go 서버로 전달한다.
// SSH 접속 · 프로세스 확인은 Go 서버만 할 수 있으므로, 개발 중에도 Go 서버를 같이 실행해야 한다.
//
//   cd go-server/cmd/server && go run .        ( 기본 :8088 )
//   npm start                                   ( :3000, /api → :8088 )
//
// Go 서버 주소가 다르면 API_PROXY_TARGET 으로 바꾼다. 예) API_PROXY_TARGET=http://localhost:9000 npm start
// CRA 가 개발 서버를 띄울 때 자동으로 불러오는 파일이며, 빌드 결과물에는 포함되지 않는다.
// 이 파일을 수정하면 npm start 를 다시 시작해야 반영된다.
const { createProxyMiddleware } = require('http-proxy-middleware');

const target = process.env.API_PROXY_TARGET || 'http://localhost:8088';

module.exports = function setupApiProxy(app) {
  // app.use('/api', ...) 로 걸면 express 가 경로에서 /api 를 떼고 전달하므로, 경로 조건을 미들웨어에 준다.
  app.use(
    createProxyMiddleware('/api', {
      target,
      // 프로세스 시작 · 재시작은 최대 수십 초 걸릴 수 있다.
      proxyTimeout: 60000,
      onError: (err, req, res) => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Go 서버(${target})에 연결할 수 없습니다: ${err.code || err.message}` }));
      },
    })
  );
};
