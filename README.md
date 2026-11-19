# Process Management

여러 서버에 SSH 로 접속해 등록한 프로세스의 실행 상태(PID · CPU · MEM · 실행 시간)를 확인하고,
로그 폴더를 둘러보며 로그 파일을 보고, INI 설정 파일을 읽고 고치고, 시작 · 중지 · 재시작하는 관리 화면입니다. 꺼진 프로세스를 자동으로 다시 시작할 수도 있습니다. 서버는 사용자가 만든 그룹(의왕, 광명 ...)으로
묶어서 보여주고, 그룹마다 주소가 나뉩니다. (`/all` 전체, `/uw` 의왕만)

```
브라우저 ──HTTP──▶ Go 서버 (/api) ──SSH (비밀번호)──▶ 각 서버: ps / ls / tail / cat (INI) / kill / 시작 스크립트
                    └ 자동 재시작 감시 (watchIntervalMs 마다)
```

## 설계 원칙

- **정해진 명령만 실행**: 설정에는 명령을 적지 않고, 프로세스를 찾을 정규식(`match`)과 로그 폴더 ·
  시작 스크립트 경로만 적습니다. Go 서버가 `ps`, `ls`, `tail`, `kill -TERM <PID>`, `nohup <스크립트>` 만 만들어
  실행하며, 설정의 경로는 셸 특수문자가 없는 절대 경로만 허용합니다.
- **로그는 폴더 단위**: 로그 폴더(`logDir`) 아래의 파일 · 폴더 목록을 보여주고, 고른 파일을 `tail` 로 봅니다.
  `..` 이 들어간 경로처럼 로그 폴더 밖을 가리키는 요청은 거부합니다. (폴더 안의 심볼릭 링크가 가리키는 곳은 막지 않습니다)
- **INI 는 안전하게 덮어쓰기**: INI 폴더(`configDir`) 아래의 `*.ini` 만 열고 고칩니다. 저장할 때는 읽었던 내용의 hash 를
  같이 보내 그 사이 다른 곳에서 바뀌었으면 거부하고, 받은 내용을 임시 파일에 다 쓴 뒤 크기를 확인하고 나서야 원본을 바꿉니다.
  이전 내용은 `<파일>.bak` 에 남기고, 원본은 내용만 바꿔 권한 · 소유자를 유지합니다. UTF-8 이 아닌 파일은 열지 않습니다.
- **자동 재시작은 정확한 비교로**: 모니터링 화면의 `감시` 창에서 프로세스별로 켜고 끕니다. 화면 표시용 `match`(정규식)와 따로, 감시 프로세스를 실행 파일 이름(`watchName`,
  정확히 일치)과 명령줄에 들어 있어야 할 문자열(`watchArgs`)로 적습니다. 둘 중 하나만 적어도 되고, 둘 다 적으면
  한 프로세스가 둘 다 만족해야 합니다. 감시 프로세스가 `ps` 에 없으면 시작
  스크립트를 실행하고, 재시작 대기(`restartDelayMs`, 기본 30초) 뒤에도 없으면 횟수 제한 없이 다시 실행합니다. 화면에서 **중지**하면 다시
  시작할 때까지 자동 재시작을 멈춥니다. (이 '멈춤' 과 재시작 횟수는 Go 서버 메모리에만 있어서, Go 서버를 다시 켜면
  풀립니다. 오래 꺼 둘 프로세스는 설정에서 자동 재시작을 끄세요)
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
  "watchIntervalMs": 10000,
  "restartDelayMs": 30000,
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
      "logDir": "/opt/shelter/logs",
      "configDir": "/opt/shelter/conf",
      "startScript": "/opt/shelter/start.sh",
      "autoRestart": true,
      "watchName": "java",
      "watchArgs": "/opt/shelter/shelter.jar"
    }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `pollIntervalMs` | | 상태 확인 주기(ms). 1000 이상, 생략 시 5000 |
| `watchIntervalMs` | | 자동 재시작 확인 주기(ms). 1000 이상, 생략 시 10000 |
| `restartDelayMs` | | 자동 · 화면에서 시작한 뒤 프로세스가 뜨기를 기다리는 시간(ms). 이 시간 안에는 다시 자동 시작하지 않습니다. 1000 이상, 생략 시 30000 |
| `groups[].slug` | ✓ | 주소 경로(`/uw`). 영문 소문자 · 숫자 · `-`. `all` `api` `config` `static` `log-config` 제외 |
| `groups[].name` | ✓ | 탭 · 제목에 보일 이름 |
| `servers[].id` / `group` | ✓ | 고유 id / 그룹 slug |
| `servers[].host` / `port` / `user` / `password` | ✓ (port 제외) | SSH 접속 정보. port 생략 시 22 |
| `servers[].label` | | 표시 이름 (생략 시 id) |
| `processes[].id` / `server` | ✓ | 고유 id / 서버 id |
| `processes[].match` | ✓ | `ps` 명령줄에 대한 정규식(Go RE2). 다른 프로세스와 겹치지 않게 구체적으로 (`worker\.sh` 는 `com.apple.mdworker.shared` 에도 맞습니다) |
| `processes[].logDir` | | 로그 폴더의 절대 경로. 로그 보기에서 이 폴더 아래를 둘러봅니다 |
| `processes[].configDir` | | INI 폴더의 절대 경로. `INI` 버튼으로 이 폴더 아래의 `*.ini` 를 읽고 고칩니다 |
| `processes[].startScript` | | 시작 · 재시작 때 인자 없이 실행할 스크립트의 절대 경로. 스크립트가 있는 폴더에서 `nohup` 으로 실행하고 출력은 버리므로, 로그는 스크립트가 직접 남겨야 합니다 |
| `processes[].label` | | 표시 이름 (생략 시 id) |
| `processes[].autoRestart` | | 이것과 `watchName` · `watchArgs` 는 ⚙ 설정이 아니라 모니터링 화면의 `감시` 창에서 바꿉니다. `true` 면 감시 프로세스가 없을 때 시작 스크립트를 자동 실행합니다. `startScript` 와, `watchName` · `watchArgs` 중 하나 이상 필요 |
| `processes[].watchName` | | 감시 프로세스의 실행 파일 이름. `ps` 명령줄 첫 단어의 파일 이름과 정확히 같아야 합니다 (`/usr/bin/java ...` → `java`, `#!/bin/sh` 스크립트 → `sh`). 비우면 보지 않습니다 |
| `processes[].watchArgs` | | 감시 프로세스의 명령줄에 들어 있어야 하는 문자열 (정규식 아님). 비우면 보지 않습니다. 이것만 쓸 때는 `vi` · `tail` 처럼 같은 경로를 연 다른 프로그램도 맞으므로, 그 프로세스만 가진 문자열로 적으세요 |

- 배열 순서가 화면 표시 순서입니다.
- 저장할 때 설정 창을 연 시점의 `version`(파일 내용의 hash)을 같이 보내, 그 사이 `감시` 창 · 다른 사용자 · 직접 수정으로
  파일이 바뀌었으면 덮어쓰지 않고 거부합니다(409). 설정 창은 열 때마다 최신 설정을 다시 읽습니다.
- 규칙은 프론트(`src/config/schema.ts`)와 Go 서버(`go-server/internal/processes/config.go`)가 같은 내용으로 검사합니다.
- 중지는 match 로 찾은 PID 에 SIGTERM 을 보내고 10초 기다립니다. 그 안에 종료되지 않으면 실패로 알려주며 SIGKILL 은 보내지 않습니다.
- 예전 설정의 `logFile`(파일 하나)은 읽을 때 그 파일이 있는 폴더(`logDir`)로 바뀌고, 다음 저장 때 `logDir` 로 저장됩니다.

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
    ServerCard/              서버 1대: 접속 상태 + 프로세스 표 + 자동 재시작 상태 + 로그 · INI · 감시 · 시작 · 중지 버튼
    LogViewer/               로그 · INI 폴더 둘러보기 → 로그 보기 (줄 수, 필터, 자동 새로고침) 또는 INI 편집
    IniEditor/               INI 파일 편집 · 저장 (CRLF 유지, 동시 수정 감지)
    WatchEditor/             자동 재시작 · 감시 조건 변경, 지금 맞는 프로세스 확인
    ConfigEditor/            그룹 · 서버 · 프로세스 편집 / 가져오기 / 내보내기
    MarkdownPanel/           config/README.md · API.md 를 접이식 패널로 표시
  pages/Dashboard.tsx        그룹 → 서버 → 프로세스 화면 구성, 검색, 사이드바 이동
  App.tsx                    경로 라우팅 (/ → /all)
  setupProxy.js              npm start 에서 /api 를 Go 서버로 전달

go-server/internal/
  processes/
    config.go                설정 타입 · 검사 · 저장 (비밀번호 유지 규칙)
    remote.go                SSH 연결 재사용 · 명령 실행 · known_hosts 확인
    monitor.go               ps 로 상태 확인, kill · 시작 스크립트로 제어
    files.go                 로그 · INI 폴더 목록(ls), 로그 tail, INI 읽기 · 쓰기
    watchdog.go              자동 재시작 감시 (watchName · watchArgs), 감시 조건 확인
  transport/rest.go          /api 핸들러
```
