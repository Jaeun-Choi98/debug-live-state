# API 명세

debug-live-state 는 두 종류의 HTTP 요청을 다룹니다.

1. **모니터링 대상 API**: 화면(브라우저)이 각 백엔드의 디버그 상태 API 를 직접 호출합니다.
2. **사이트 자체 API**: 화면이 설정을 읽고 저장할 때 사이트 서버(Go 서버, 개발 중에는 `npm start`)를 호출합니다.

---

## 1. 모니터링 대상 API (각 백엔드가 제공)

`⚙ 설정` 에 등록한 URL 을 엔드포인트마다 정해진 주기로 호출합니다.

| 항목 | 내용 |
|---|---|
| 메서드 | `GET` (본문 · 헤더 없음) |
| 응답 | `2xx` + JSON 본문. 객체 전체를 그대로 트리로 보여줍니다 |
| 타임아웃 | 5초 안에 응답(본문 포함)이 없으면 `timeout` 오류로 표시합니다 |
| 주기 | 응답을 받은 뒤 `pollIntervalMs` 만큼 기다렸다 다시 호출합니다 (요청이 겹치지 않음) |
| CORS | 브라우저가 직접 호출하므로 대상 백엔드가 이 사이트 origin 을 허용해야 합니다 (`Access-Control-Allow-Origin`) |

| 화면 표시 | 원인 |
|---|---|
| `http 500 ...` | 대상 API 가 2xx 가 아닌 상태 코드를 돌려줌 |
| `network error: ...` | 서버가 꺼져 있음, 주소 오류, CORS 미허용 |
| `timeout: 5000ms ...` | 5초 안에 응답 없음 |

---

## 2. 사이트 자체 API

배포에서는 **Go 서버**(`go-server`, 기본 포트 `8088`)가, 개발 중에는 **`npm start` 개발 서버**(`src/setupProxy.js`)가 제공합니다.

### GET /api/config

엔드포인트 설정을 조회합니다. 화면을 열 때와 `↻ Reload Config` 를 누를 때 호출합니다.

- Go 서버: `env.ini` 의 `[ENDPOINTS] FILE` (기본 `./data/endpoints.json`). 한 번도 저장하지 않았으면 `build/config/endpoints.json`
- 개발 서버: `public/config/endpoints.json`

응답 `200` (`application/json`)

```json
{
  "pollIntervalMs": 3000,
  "endpoints": [
    { "id": "order-engine", "group": "Trading", "label": "Order Engine", "url": "http://host:8081/debug/state", "pollIntervalMs": 1000 }
  ]
}
```

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| pollIntervalMs | number | | 기본 폴링 주기(ms). 1 이상의 정수. 없으면 3000 |
| endpoints | array | O | 표시 순서대로 나열한 엔드포인트 목록 |
| endpoints[].id | string | O | 고유 id (중복 불가) |
| endpoints[].group | string | | 묶어서 보여줄 그룹 이름 |
| endpoints[].label | string | | 화면 표시 이름 (없으면 id) |
| endpoints[].url | string | O | `http://` 또는 `https://` 주소 |
| endpoints[].pollIntervalMs | number | | 이 엔드포인트의 폴링 주기(ms). 1 이상의 정수 |

| 상태 코드 | 의미 |
|---|---|
| `500` | 설정 파일을 읽지 못함 `{"error": "..."}` |

> 이 API 가 없으면(정적 호스팅) 화면은 `config/endpoints.json` 을 읽기 전용으로 읽고, 저장 버튼이 비활성화됩니다.

### PUT /api/config

`⚙ 설정` 에서 **저장**을 누르면 호출합니다. 설정 전체를 교체합니다.

- 요청: `Content-Type: application/json`, 본문은 GET 응답과 같은 형식 (최대 1MB)
- 응답 `200`: 실제로 저장된 설정 (보기 좋게 정리된 JSON)

| 상태 코드 | 의미 |
|---|---|
| `400` | 형식 오류. 문제를 모두 모아 `{"error": "...\nendpoints[1].url: ..."}` 로 돌려줌. 알 수 없는 필드도 거부 (Go 서버) |
| `413` | 본문이 1MB 를 넘음 (Go 서버) |
| `500` | 파일을 저장하지 못함 |

> 인증이 없으므로 서버에 접속할 수 있는 사람은 누구나 설정을 바꿀 수 있습니다. Go 서버는 저장한 요청의 IP 를 로그에 남깁니다.

### GET /api/health (Go 서버)

서버 동작 확인용입니다. 응답 `200` `{"status": "ok"}`

### GET /log-config (Go 서버)

로그 레벨을 조회하거나, 실행 중에 바꿉니다. 재시작하면 `env.ini` 의 값으로 돌아갑니다.

| 요청 | 동작 |
|---|---|
| `GET /log-config` | 현재 레벨 조회 → `{"level": "INFO"}` |
| `GET /log-config?level=debug` | 레벨 변경 (`debug` / `info` / `warn` / `error`) 후 바뀐 레벨을 돌려줌. 잘못된 값이면 `400` |

### 정적 파일

| 경로 | 내용 |
|---|---|
| `/` 및 확장자 없는 경로 | 화면(`index.html`) |
| `/config/endpoints.json` | 기본 설정 파일 |
| `/config/README.md` | 대시보드 위 소개 · 사용 방법 |
| `/config/API.md` | 이 문서 |

없는 파일(확장자가 있는 경로), `.ini` · `.map` 파일, `/api` 아래의 없는 경로는 `404` 입니다. (Go 서버)
