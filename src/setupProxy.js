// npm start(개발 서버)에서도 ⚙ 설정 → 저장이 되도록 설정 API(/api/config)를 제공한다.
// CRA 가 개발 서버를 띄울 때 자동으로 불러오는 파일이며, 빌드 결과물에는 포함되지 않는다.
//
//   GET /api/config  → public/config/endpoints.json 을 그대로 돌려준다.
//   PUT /api/config  → 받은 설정을 public/config/endpoints.json 에 저장한다.
//
// 배포(Go 서버)에서는 Go 서버의 /api/config 가 같은 역할을 한다. (go-server/internal/endpoints)
// 이 파일을 수정하면 npm start 를 다시 시작해야 반영된다.
const fs = require('fs');
const path = require('path');
const express = require('express');

const CONFIG_FILE = path.join(__dirname, '..', 'public', 'config', 'endpoints.json');

module.exports = function setupConfigApi(app) {
  app.get('/api/config', (req, res) => {
    res.type('json').send(fs.readFileSync(CONFIG_FILE, 'utf8'));
  });

  // 자세한 검사는 화면(src/config/schema.ts)에서 저장 전에 이미 했으므로 형태만 확인한다.
  app.put('/api/config', express.json({ limit: '1mb' }), (req, res) => {
    if (!Array.isArray(req.body?.endpoints)) {
      res.status(400).json({ error: 'endpoints: 배열이 필요합니다' });
      return;
    }
    // 쓰는 도중 실패해도 기존 파일이 깨지지 않도록 임시 파일에 쓴 뒤 바꿔치기한다.
    const tmpFile = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(req.body, null, 2) + '\n');
    fs.renameSync(tmpFile, CONFIG_FILE);
    res.json(req.body);
  });
};
