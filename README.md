# Process Management

여러 서버에 SSH 로 접속해 등록한 프로세스의 실행 상태(PID · CPU · MEM · 실행 시간)를 확인하고,
로그 파일을 보고, 시작 · 중지 · 재시작하는 관리 화면입니다. 서버는 사용자가 만든 그룹(의왕, 광명 ...)으로
묶어서 보여주고, 그룹마다 주소가 나뉩니다. (`/all` 전체, `/uw` 의왕만)

```
브라우저 ──HTTP──▶ Go 서버 (/api) ──SSH (비밀번호)──▶ 각 서버: ps / tail / kill / 시작 스크립트
```

## 설계 원칙

- **정해진 명령만 실행**: 설정에는 명령을 적지 않고, 프로세스를 찾을 정규식(`match`)과 로그 파일 ·
  시작 스크립트 경로만 적습니다. Go 서버가 `ps`, `tail`, `kill -TERM <PID>`, `nohup <스크립트>` 만 만들어
  실행하며, 경로는 셸 특수문자가 없는 절대 경로만 허용합니다.
- **비밀번호는 쓰기 전용**: ⚙ 설정에서 입력한 SSH 비밀번호는 Go 서버의 설정 파일(0600)에만 저장되고,
  조회 API 는 `hasPassword` 만 돌려줍니다. 비워 두고 저장하면 기존 비밀번호를 유지하되, host · port · user 가
  바뀌면 다시 입력해야 합니다. (저장된 비밀번호를 다른 서버로 보낼 수 없도록)
- **호스트 키 확인**: 처음 접속한 서버의 호스트 키를 `known_hosts` 에 기록하고, 이후 키가 다르면 접속하지
  않습니다. 서버를 재설치했다면 해당 줄을 지우세요.
- **서버 부하 제한**: 상태 확인은 서버당 `ps` 한 번으로 그 서버의 모든 프로세스를 판단하고, 여러 사람이 보고
  있어도 서버마다 2초에 한 번만 실행합니다. SSH 연결은 열어 두고 재사용합니다.
- **경로 라우팅**: `/all` 은 전체 그룹, `/<그룹 slug>` 는 그 그룹만 보여주고 상태도 그 그룹만 확인합니다.

> ⚠ 로그인이 없습니다. 화면에 접속할 수 있는 사람은 누구나 설정을 바꾸고 프로세스를 중지할 수 있으므로
> 내부망에서만 여세요. 상태를 바꾸는 요청은 `Content-Type: application/json` 을 요구해 다른 사이트를 통한
> 요청(CSRF)만 막습니다. 제어 요청은 요청한 IP 와 함께 서버 로그에 남습니다.

## 설정 (`processes.json`)

⚙ 설정 화면에서 편집하며, Go 서버의 `env.ini` `[PROCESSES] FILE` (기본 `./data/processes.json`)에 저장됩니다.

```json
{
  "pollIntervalMs": 5000,
  "groups": [{ "slug": "uw", "name": "의왕" }],
  "servers": [
    { "id": "uw-app1", "group": "uw", "label": "의왕 APP 1", "host": "10.0.0.11", "port": 22, "user": "ops", "password": "..." }
  ],
  "processes": [
    {
      "id": "shelter",
      "server": "uw-app1",
      "label": "Shelter",
      "match": "java .*shelter\\.jar",
      "logFile": "/opt/shelter/logs/app.log",
      "startScript": "/opt/shelter/start.sh"
    }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `pollIntervalMs` | | 상태 확인 주기(ms). 1000 이상, 생략 시 5000 |
| `groups[].slug` | ✓ | 주소 경로(`/uw`). 영문 소문자 · 숫자 · `-`. `all` `api` `config` `static` `log-config` 제외 |
| `groups[].name` | ✓ | 탭 · 제목에 보일 이름 |
| `servers[].id` / `group` | ✓ | 고유 id / 그룹 slug |
| `servers[].host` / `port` / `user` / `password` | ✓ (port 제외) | SSH 접속 정보. port 생략 시 22 |
| `servers[].label` | | 표시 이름 (생략 시 id) |
| `processes[].id` / `server` | ✓ | 고유 id / 서버 id |
| `processes[].match` | ✓ | `ps` 명령줄에 대한 정규식(Go RE2). 다른 프로세스와 겹치지 않게 구체적으로 (`worker\.sh` 는 `com.apple.mdworker.shared` 에도 맞습니다) |
| `processes[].logFile` | | 로그 보기에서 `tail` 할 파일의 절대 경로 |
| `processes[].startScript` | | 시작 · 재시작 때 인자 없이 실행할 스크립트의 절대 경로. 스크립트가 있는 폴더에서 `nohup` 으로 실행하고 출력은 버리므로, 로그는 스크립트가 직접 남겨야 합니다 |
| `processes[].label` | | 표시 이름 (생략 시 id) |

- 배열 순서가 화면 표시 순서입니다.
- 규칙은 프론트(`src/config/schema.ts`)와 Go 서버(`go-server/internal/processes/config.go`)가 같은 내용으로 검사합니다.
- 중지는 match 로 찾은 PID 에 SIGTERM 을 보내고 10초 기다립니다. 그 안에 종료되지 않으면 실패로 알려주며 SIGKILL 은 보내지 않습니다.

### 사이트 안내문 (config/README.md, config/API.md)

`public/config/README.md` 는 화면 위에 보이는 소개 · 사용 방법이고(처음엔 펼침), `public/config/API.md` 는
그 아래의 API 명세입니다(처음엔 접힘). 파일을 고치고 새로고침하면 바로 반영되고(빌드한 경우
`build/config/README.md`), 파일을 지우면 패널도 사라집니다. 제목, 목록, 코드, 표, 인용, `**굵게**`,
`[링크](https://...)` 정도의 마크다운만 지원하며, HTML 태그는 글자로 그대로 보입니다.
**API 를 바꾸면 `API.md` 도 같이 고쳐야 합니다.**

## 실행

SSH 접속은 Go 서버만 할 수 있으므로 개발 중에도 Go 서버를 같이 띄웁니다.

```bash
# 1) Go 서버 (:8088)
cd go-server/cmd/server
go run .

# 2) 화면 (:3000, /api 는 :8088 로 전달)
npm install
npm start
```

Go 서버 주소가 다르면 `API_PROXY_TARGET=http://localhost:9000 npm start` 처럼 지정합니다.
`src/setupProxy.js` 를 수정하면 `npm start` 를 다시 시작해야 합니다.

### 배포

```bash
npm run build
rsync -a --delete build/ go-server/cmd/server/build/
cd go-server/cmd/server && go build -o main . && ./main
```

`data/`(설정 · known_hosts)는 `build/` 밖에 있으므로 재배포해도 유지됩니다. git 에는 올리지 않습니다.

## 폴더 구조

```
src/
  config/
    types.ts                 설정(processes.json) · 상태 응답 타입
    schema.ts                설정 검사 (화면 · 가져오기 · 불러오기 공통)
  hooks/
    useProcessConfig.ts      설정 조회/저장(/api/config) + API 호출 공통 함수
    useGroupStatus.ts        그룹 상태 폴링(/api/status)
  components/
    Header/                  그룹 탭 (/all, /uw ...)
    StatusSidebar/           그룹 · 서버 상태 사이드바 (클릭 시 카드로 이동)
    ServerCard/              서버 1대: 접속 상태 + 프로세스 표 + 로그 · 시작 · 중지 버튼
    LogViewer/               로그 보기 (줄 수, 필터, 자동 새로고침)
    ConfigEditor/            그룹 · 서버 · 프로세스 편집 / 가져오기 / 내보내기
    MarkdownPanel/           config/README.md · API.md 를 접이식 패널로 표시
  pages/Dashboard.tsx        그룹 → 서버 → 프로세스 화면 구성, 검색, 사이드바 이동
  App.tsx                    경로 라우팅 (/ → /all)
  setupProxy.js              npm start 에서 /api 를 Go 서버로 전달

go-server/internal/
  processes/
    config.go                설정 타입 · 검사 · 저장 (비밀번호 유지 규칙)
    remote.go                SSH 연결 재사용 · 명령 실행 · known_hosts 확인
    monitor.go               ps 로 상태 확인, tail 로그, kill · 시작 스크립트로 제어
  transport/rest.go          /api 핸들러
```
