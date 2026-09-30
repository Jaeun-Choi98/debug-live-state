# Debug GUI

여러 모니터링 백엔드의 상태 객체를 실시간으로 확인하기 위한 디버깅용 대시보드입니다.
`public/config/endpoints.ini` 에 GET 엔드포인트 목록을 등록하면, 화면이 주기적으로
각 엔드포인트를 호출해 응답 JSON 전체를 그대로 트리 뷰로 보여줍니다.

## 설계 원칙

- **읽기 전용 / GET only**: 특정 필드만 골라오는 API가 아니라, 객체 전체를 반환하는
  디버그용 GET API만 등록합니다. 백엔드마다 응답 구조가 달라도 동일한 UI로 일관되게
  볼 수 있도록 하기 위함입니다.
- **설정은 정적 파일**: `endpoints.ini` 는 `public/` 아래에 있는 정적 파일이라, 빌드 없이
  파일만 수정하고 대시보드의 "Reload Config" 버튼을 누르면 바로 반영됩니다.
- **엔드포인트별 독립 폴링**: 각 카드가 자신의 주기로 독립적으로 폴링합니다(느린 백엔드가
  다른 카드에 영향을 주지 않음). 응답이 오기 전에는 다음 요청을 쌓지 않습니다.
- **탐색 기능**: 상단 검색창에 key/value를 입력하면, 해당 값이 없는 카드는 숨겨지고,
  일치하는 값은 하이라이트되며 중첩된 위치까지 자동으로 펼쳐집니다. curl로는 찾기 힘든
  크고 불규칙한 JSON에서 원하는 값을 빠르게 찾기 위한 용도입니다.

## 설정 (`public/config/endpoints.ini`)

```ini
[global]
poll_interval_ms=3000        ; 섹션별로 지정하지 않았을 때의 기본 폴링 주기

[order-engine]
label=Order Engine State     ; 화면에 표시될 이름 (생략 시 섹션 이름 사용)
url=http://localhost:8081/debug/state
poll_interval_ms=1000        ; 이 엔드포인트만의 폴링 주기 (생략 가능)
```

- 섹션 이름(`[order-engine]`)은 고유해야 하며 카드의 내부 key로 쓰입니다.
- `url` 은 필수이며, 항상 GET으로 호출됩니다.
- `[global]` 섹션은 선택 사항입니다.

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
  config/                    ini 파서 + 설정 로더 + 타입
  hooks/
    useEndpointsConfig.ts    ini 설정 로드/리로드
    useEndpointPoller.ts     엔드포인트 1개에 대한 폴링 상태 관리 (일시정지/새로고침 포함)
    useNowTick.ts            "n초 전" 표시 갱신용
  components/
    JsonViewer/              접기/펼치기 + 검색 하이라이트가 되는 JSON 트리 뷰
    EndpointCard/             카드 1개 (상태 뱃지, 지연시간, JsonViewer)
    Header/
  pages/Dashboard.tsx        카드 그리드 + 검색 + Reload Config
```
