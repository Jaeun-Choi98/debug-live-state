# Debug GUI

여러 모니터링 백엔드의 상태 객체를 실시간으로 확인하기 위한 디버깅용 대시보드입니다.
GET 엔드포인트 목록(`endpoints.json`)을 등록하면, 화면이 주기적으로 각 엔드포인트를
호출해 응답 JSON 전체를 그대로 트리 뷰로 보여줍니다. 엔드포인트는 화면의 ⚙ 설정에서
추가/수정/삭제하고, JSON 파일로 가져오기/내보내기 할 수 있습니다.

## 설계 원칙

- **읽기 전용 / GET only**: 특정 필드만 골라오는 API가 아니라, 객체 전체를 반환하는
  디버그용 GET API만 등록합니다. 백엔드마다 응답 구조가 달라도 동일한 UI로 일관되게
  볼 수 있도록 하기 위함입니다.
- **설정은 서버 파일에 저장**: ⚙ 설정에서 수정한 내용은 `PUT /api/config` 로 서버 파일에
  저장되어 모든 사용자에게 반영됩니다. 배포에서는 Go 서버가, `npm start` 에서는 개발 서버
  (`src/setupProxy.js`)가 이 API를 제공합니다.
- **엔드포인트별 독립 폴링**: 각 카드가 자신의 주기로 독립적으로 폴링합니다(느린 백엔드가
  다른 카드에 영향을 주지 않음). 응답이 오기 전에는 다음 요청을 쌓지 않습니다.
- **탐색 기능**: 상단 검색창에 key/value를 입력하면, 해당 값이 없는 카드는 숨겨지고,
  일치하는 값은 하이라이트되며 중첩된 위치까지 자동으로 펼쳐집니다. curl로는 찾기 힘든
  크고 불규칙한 JSON에서 원하는 값을 빠르게 찾기 위한 용도입니다.

## 설정 (`endpoints.json`)

```json
{
  "pollIntervalMs": 3000,
  "endpoints": [
    {
      "id": "order-engine",
      "group": "Trading",
      "label": "Order Engine State",
      "url": "http://localhost:8081/debug/state",
      "pollIntervalMs": 1000
    }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `pollIntervalMs` (최상위) | | 엔드포인트별로 지정하지 않았을 때의 기본 폴링 주기. 생략 시 3000 |
| `endpoints[].id` | ✓ | 고유 id. 카드의 내부 key 로 쓰입니다 |
| `endpoints[].url` | ✓ | `http://` 또는 `https://` 주소. 항상 GET 으로 호출됩니다 |
| `endpoints[].group` | | 묶어서 보여줄 그룹(컨테이너/프로젝트) 이름. 생략 시 "미분류" (모두 생략하면 그룹 없이 표시) |
| `endpoints[].label` | | 화면에 표시할 이름. 생략 시 id |
| `endpoints[].pollIntervalMs` | | 이 엔드포인트만의 폴링 주기 |

- 배열 순서가 화면 표시 순서이고, 그룹 순서는 처음 등장한 순서를 따릅니다.
- 규칙은 프론트(`src/config/schema.ts`)와 Go 서버(`go-server/internal/endpoints/store.go`)가
  같은 내용으로 검사합니다.

### 사이트 안내문 (config/README.md, config/API.md)

`public/config/README.md` 는 사이트에 들어왔을 때 대시보드 위에 보이는 소개 · 사용 방법이고(처음엔 펼침),
`public/config/API.md` 는 그 아래의 프론트 · 백엔드 API 명세입니다(처음엔 접힘).
파일을 고치고 새로고침하면 바로 반영되고(빌드한 경우 `build/config/README.md`), 파일을 지우면 패널도
사라집니다. 제목, 목록, 코드, 표, 인용, `**굵게**`, `[링크](https://...)` 정도의 마크다운만 지원하며,
HTML 태그는 글자로 그대로 보입니다.

### 설정이 저장되는 곳

| 실행 방식 | 읽는 곳 | 저장 |
|---|---|---|
| Go 서버 | `GET /api/config`: `env.ini` 의 `[ENDPOINTS] FILE` (기본 `./data/endpoints.json`). 아직 저장한 적이 없으면 `build/config/endpoints.json` | `PUT /api/config` 로 `[ENDPOINTS] FILE` 에 저장 |
| `npm start` | `public/config/endpoints.json` | `src/setupProxy.js` 가 같은 파일에 저장 |
| 정적 호스팅 (API 없음) | `config/endpoints.json` | 불가 (내보내기 후 파일 교체) |

저장 파일은 `build/` 밖에 두므로, 재배포로 `build/` 를 교체해도 화면에서 수정한 설정은 유지됩니다.
`npm start` 에서 저장한 `public/config/endpoints.json` 은 다음 `npm run build` 때 빌드에 포함되어
Go 서버의 기본 설정이 됩니다. `src/setupProxy.js` 를 수정하면 `npm start` 를 다시 시작해야 합니다.

## 실행

```bash
npm install
npm start
```

`http://localhost:3000` 에서 확인할 수 있습니다.

## CORS 주의사항

이 GUI는 자체 백엔드 없이 브라우저에서 각 모니터링 백엔드에 **직접** GET 요청을 보냅니다.
따라서 각 대상 백엔드가 이 GUI를 서빙하는 origin에 대해 CORS를 허용해야 합니다
(디버그 전용 엔드포인트이므로 보통 `Access-Control-Allow-Origin: *` 정도로 단순하게 열어두는
경우가 많습니다). 허용되지 않으면 해당 카드는 네트워크 에러로 표시됩니다.

## 폴더 구조

```
src/
  api/client.ts              GET 전용 fetch 클라이언트 (지연시간 측정 포함)
  config/
    types.ts                 설정 파일(endpoints.json) 타입
    schema.ts                설정 검사 (화면 · 가져오기 · 불러오기 공통)
    groups.ts                그룹별 묶기
  hooks/
    useEndpointsConfig.ts    설정 조회/저장(/api/config) + 기본값 채우기
    useEndpointPoller.ts     엔드포인트 1개에 대한 폴링 상태 관리 (일시정지/새로고침 포함)
    useNowTick.ts            "n초 전" 표시 갱신용
  components/
    JsonViewer/              접기/펼치기 + 검색 하이라이트가 되는 JSON 트리 뷰
    EndpointCard/             카드 1개 (상태 뱃지, 지연시간, JsonViewer)
    StatusSidebar/           그룹별 상태 사이드바 (클릭 시 카드로 이동)
    ConfigEditor/            설정 편집 / 가져오기 / 내보내기
    MarkdownPanel/           config/README.md · API.md 를 대시보드 위 접이식 패널로 표시
    Header/
  pages/Dashboard.tsx        사이드바 + 그룹별 카드 + 검색 + 설정
  setupProxy.js              npm start 용 설정 API (GET/PUT /api/config)
```
