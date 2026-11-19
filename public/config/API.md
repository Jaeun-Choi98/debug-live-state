# API 명세

화면(브라우저)은 사이트 서버(Go 서버)의 API 만 호출합니다. Go 서버가 각 서버에 SSH 로 접속해 정해진 명령만 실행합니다.

```
브라우저 ──HTTP──▶ Go 서버 (/api) ──SSH (비밀번호)──▶ 각 서버: ps / tail / kill / 시작 스크립트
```

- 배포: **Go 서버**(`go-server`, 기본 포트 `8088`)가 화면과 API 를 함께 제공합니다.
- 개발: `npm start`(`:3000`)가 `/api` 요청을 Go 서버로 전달합니다 (`src/setupProxy.js`, 주소는 `API_PROXY_TARGET`).
- 상태를 바꾸는 요청(`PUT`, `POST`)은 `Content-Type: application/json` 이 필요합니다. 아니면 `415` 입니다. (다른 사이트를 통한 요청 차단)
- 오류 응답은 모두 `{"error": "..."}` 형식입니다.

---

## 1. 서버에서 실행하는 명령

설정에는 명령을 적지 않습니다. Go 서버가 아래 명령만 만들어 실행합니다.

| 용도 | 명령 |
|---|---|
| 상태 확인 | `LC_ALL=C ps -eo pid=,pcpu=,pmem=,etime=,args=` (서버마다 2초에 최대 1번, 여러 사람이 봐도 공유) |
| 로그 | `tail -n <줄 수> -- '<로그 파일>'` |
| 중지 | `kill -TERM <PID ...>` (PID 는 ps 결과에서 match 정규식으로 찾은 값) |
| 시작 | 아래 명령 (스크립트가 있는 폴더에서 백그라운드로 실행, 출력은 버림) |

```
cd '<스크립트 폴더>' || exit 1; nohup '<시작 스크립트>' > /dev/null 2>&1 < /dev/null &
```

- SSH 연결은 서버마다 열어 두고 재사용합니다. 설정을 저장하면 모두 닫고 다시 연결합니다.
- 처음 접속한 서버의 호스트 키를 `known_hosts` 에 기록하고, 다음부터 키가 다르면 접속하지 않습니다.
- 명령은 10초 안에 끝나지 않으면 실패로 처리합니다.

---

## 2. 사이트 API

### GET /api/config

그룹 · 서버 · 프로세스 설정을 조회합니다. 비밀번호 대신 저장 여부(`hasPassword`)만 내려줍니다.

```json
{
  "pollIntervalMs": 5000,
  "groups": [{ "slug": "uw", "name": "의왕" }],
  "servers": [
    { "id": "uw-app1", "group": "uw", "label": "의왕 APP 1", "host": "10.0.0.11", "port": 22, "user": "ops", "hasPassword": true }
  ],
  "processes": [
    { "id": "shelter", "server": "uw-app1", "label": "Shelter", "match": "java .*shelter\\.jar",
      "logFile": "/opt/shelter/logs/app.log", "startScript": "/opt/shelter/start.sh" }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| pollIntervalMs | | 상태 확인 주기(ms). 1000 이상. 없으면 5000 |
| groups[].slug | O | 주소 경로. 영문 소문자 · 숫자 · `-`. `all` `api` `config` `static` `log-config` 제외 |
| groups[].name | O | 탭 · 제목에 보일 이름 |
| servers[].id | O | 고유 id |
| servers[].group | O | 그룹 slug |
| servers[].label | | 표시 이름 (없으면 id) |
| servers[].host | O | 호스트 이름 또는 IP |
| servers[].port | | SSH 포트 (없으면 22) |
| servers[].user | O | SSH 사용자 |
| servers[].password | | **쓰기 전용**. 저장할 때 비워 두면 기존 비밀번호를 유지합니다. 단 host · port · user 가 바뀌었으면 다시 넣어야 합니다 |
| servers[].hasPassword | | **조회 전용**. 비밀번호가 저장되어 있으면 true |
| processes[].id | O | 고유 id (모든 서버에서 유일) |
| processes[].server | O | 서버 id |
| processes[].label | | 표시 이름 (없으면 id) |
| processes[].match | O | ps 명령줄(args)에 대한 정규식 (Go RE2 문법) |
| processes[].logFile | | 로그 파일 절대 경로 (영문 · 숫자 · `. _ - /`) |
| processes[].startScript | | 시작 스크립트 절대 경로 (영문 · 숫자 · `. _ - /`) |

### PUT /api/config

`⚙ 설정` 에서 **저장**을 누르면 호출합니다. 설정 전체를 교체하고, 저장된 설정을 GET 과 같은 형식으로 돌려줍니다.

| 상태 코드 | 의미 |
|---|---|
| `400` | 형식 오류. 문제를 모두 모아 `{"error": "...\nservers[1].host: ..."}` 로 돌려줌. 알 수 없는 필드도 거부 |
| `413` | 본문이 1MB 를 넘음 |
| `500` | 파일을 저장하지 못함 |

> 설정 파일(`env.ini` 의 `[PROCESSES] FILE`, 기본 `./data/processes.json`)에는 비밀번호가 평문으로 들어 있으므로 `0600` 으로 저장합니다.

### GET /api/status?group=uw

그룹의 서버별 프로세스 상태를 서버마다 동시에 확인합니다. `group=all`(기본값)이면 전체입니다. 화면은 `pollIntervalMs` 마다 지금 보고 있는 그룹만 호출합니다.

```json
{
  "servers": [
    {
      "id": "uw-app1",
      "checkedAt": "2026-11-19T11:15:19+09:00",
      "processes": [
        { "id": "shelter", "instances": [{ "pid": 4321, "cpu": 12.5, "mem": 3.2, "elapsed": "2-01:02:03", "command": "java -jar /opt/shelter/shelter.jar" }] }
      ]
    },
    { "id": "uw-db", "error": "ssh ops@10.0.0.12:22 접속 실패: ... connection refused", "checkedAt": "...", "processes": [] }
  ]
}
```

- `instances` 가 비어 있으면 중지된 프로세스입니다.
- SSH 접속에 실패한 서버는 `error` 에 이유가 들어가고, 나머지 서버의 결과는 그대로 옵니다. (응답은 `200`)
- 없는 그룹이면 `404`

### GET /api/processes/:id/log?lines=200

로그 파일의 마지막 `lines` 줄(1~2000, 기본 200)을 돌려줍니다. 응답 `200` `{"output": "...\n"}`

| 상태 코드 | 의미 |
|---|---|
| `400` | 로그 파일이 등록되지 않음 |
| `404` | 없는 프로세스 |
| `502` | SSH 실패 또는 tail 실패 (파일 없음 · 권한 없음 등, 서버의 오류 문구 포함) |

### POST /api/processes/:id/start · stop · restart

프로세스를 시작 · 중지 · 재시작합니다. 본문은 `{}` 입니다. 응답 `200` `{"message": "중지했습니다 · 시작 명령을 보냈습니다"}`

- **stop**: ps 로 찾은 PID 에 SIGTERM 을 보내고, 사라질 때까지 최대 10초 기다립니다. 이미 중지되어 있으면 `"이미 중지되어 있습니다"`
- **start**: 시작 스크립트를 실행합니다. 이미 실행 중이면 `409`
- **restart**: stop 후 start. 중지되어 있었으면 start 만 합니다.
- 같은 프로세스에 작업이 진행 중이면 `409`. 요청한 IP 와 결과를 서버 로그에 남깁니다.

| 상태 코드 | 의미 |
|---|---|
| `400` | 시작 스크립트가 등록되지 않음 (start · restart) |
| `404` | 없는 프로세스 또는 동작 |
| `409` | 이미 실행 중 (start) · 다른 작업 진행 중 |
| `502` | SSH 실패, 명령 실패, 10초 안에 종료되지 않음 |

### GET /api/health

서버 동작 확인용입니다. 응답 `200` `{"status": "ok"}`

### GET /log-config

Go 서버의 로그 레벨을 조회(`GET /log-config`)하거나 바꿉니다(`GET /log-config?level=debug`, `debug` / `info` / `warn` / `error`). 재시작하면 `env.ini` 값으로 돌아갑니다.

### 화면 · 정적 파일

| 경로 | 내용 |
|---|---|
| `/` | `/all` 로 이동 |
| `/all`, `/<그룹 slug>` 등 확장자 없는 경로 | 화면(`index.html`) |
| `/config/README.md` | 화면 위 소개 · 사용 방법 |
| `/config/API.md` | 이 문서 |

없는 파일(확장자가 있는 경로), `.ini` · `.map` 파일, `/api` 아래의 없는 경로는 `404` 입니다.

> 로그인이 없으므로 화면에 접속할 수 있는 사람은 누구나 설정을 바꾸고 프로세스를 중지할 수 있습니다. 내부망에서만 열어 두세요.
