# API 명세

화면(브라우저)은 사이트 서버(Go 서버)의 API 만 호출합니다. Go 서버가 각 서버에 SSH 로 접속해 정해진 명령만 실행합니다.

```
브라우저 ──HTTP──▶ Go 서버 (/api) ──SSH (비밀번호)──▶ 각 서버: ps / ls / tail / cat (INI) / kill / 시작 스크립트
                    └ 자동 재시작 감시 (watchIntervalMs 마다)
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
| 로그 · INI 파일 목록 | `LC_ALL=C ls -lndt -- <패턴 ...>` (패턴은 셸이 펼침, 최대 1000개) |
| 로그 | `tail -n <줄 수> -- '<파일>'` |
| 로그 전체 내려받기 | `wc -c` 로 크기를 잰 뒤 `head -c <크기> -- '<파일>'` (출력을 그대로 흘려보냄, 최대 30분) |
| INI 읽기 | `wc -c` 로 1MB 이하인지 본 뒤 `cat -- '<파일>'` |
| INI 쓰기 | 받은 내용을 `<파일>.pm-new` 에 쓰고 크기가 맞는지 확인 → `cp -p` 로 `<파일>.bak` 백업 → `cat <파일>.pm-new > <파일>` (권한 · 소유자 유지) → 임시 파일 삭제 |
| 중지 | `kill -TERM <PID ...>` (PID 는 ps 결과에서 match 정규식으로 찾은 값) |
| 시작 | 아래 명령 (스크립트가 있는 폴더에서 백그라운드로 실행, 출력은 버림) |

```
cd '<스크립트 폴더>' || exit 1; nohup '<시작 스크립트>' > /dev/null 2>&1 < /dev/null &
```

- SSH 연결은 서버마다 열어 두고 재사용합니다. 설정을 저장하면 모두 닫고 다시 연결합니다.
- 처음 접속한 서버의 호스트 키를 `known_hosts` 에 기록하고, 다음부터 키가 다르면 접속하지 않습니다.
- 명령은 10초 안에 끝나지 않으면 실패로 처리합니다.

### 자동 재시작

`autoRestart` 를 켠 프로세스는 Go 서버가 `watchIntervalMs`(기본 10초)마다 확인합니다. (ps 결과는 화면 조회와 공유)
`autoRestart` · `watchName` · `watchArgs` 는 모니터링 화면의 **감시** 창에서 바꿉니다. (`PUT /api/processes/:id/watch`)

- **감시 프로세스**: ps 명령줄 첫 단어의 파일 이름이 `watchName` 과 같고, 명령줄에 `watchArgs` 가 들어 있는 프로세스. 비워 둔 조건은 보지 않습니다. 화면 표시용 `match` 와 별개입니다.
- 감시 프로세스가 없으면 시작 스크립트를 실행합니다(위 시작 명령). 그 뒤 `restartDelayMs`(기본 30초) 동안은 뜨기를 기다리고, 그래도 없으면 횟수 제한 없이 다시 실행합니다.
- 화면에서 **stop** 하면 **start** · **restart** 할 때까지 자동 재시작을 멈춥니다. 화면에서 시작해도 `restartDelayMs` 동안은 자동으로 다시 실행하지 않습니다.
- 두 값은 설정 파일에서 매번 읽으므로, 저장하면 다음 확인부터 바로 적용됩니다.
- 멈춤 상태 · 재시작 횟수는 Go 서버 메모리에만 있어서, Go 서버를 다시 켜면 초기화됩니다.
- 자동 시작은 Go 서버 로그에 `[WATCHDOG]` 으로 남습니다.

---

## 2. 사이트 API

### GET /api/config

그룹 · 서버 · 프로세스 설정을 조회합니다. 비밀번호 대신 저장 여부(`hasPassword`)만 내려줍니다.

```json
{
  "version": "a59dbb97...",
  "pollIntervalMs": 5000,
  "watchIntervalMs": 10000,
  "restartDelayMs": 30000,
  "groups": [{ "slug": "uw", "name": "의왕" }],
  "servers": [
    { "id": "uw-app1", "group": "uw", "label": "의왕 APP 1", "host": "10.0.0.11", "port": 22, "user": "ops", "hasPassword": true }
  ],
  "processes": [
    { "id": "shelter", "server": "uw-app1", "label": "Shelter", "match": "java .*shelter\\.jar",
      "startScript": "/opt/shelter/start.sh", "logFiles": ["logs/*.log", "/var/log/shelter/*.log"],
      "autoRestart": true, "watchName": "java", "watchArgs": "/opt/shelter/shelter.jar" }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| version | | **조회 · 저장 전용**. 설정 파일 내용의 sha256. 파일에는 쓰지 않습니다. 저장(PUT) 때 그대로 돌려보냅니다 |
| pollIntervalMs | | 상태 확인 주기(ms). 1000 이상. 없으면 5000 |
| watchIntervalMs | | 자동 재시작 확인 주기(ms). 1000 이상. 없으면 10000 |
| restartDelayMs | | 시작한 뒤 프로세스가 뜨기를 기다리는 시간(ms). 이 시간 안에는 다시 자동 시작하지 않음. 1000 이상. 없으면 30000 |
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
| processes[].logFiles | | 로그 파일 패턴 목록 (선택, 최대 10개). **비우면 시작 스크립트 폴더의 `*.log`, `*/*.log` … `*/*/*/*/*.log` (5단계)**. 상대 경로는 시작 스크립트 폴더 기준(`..` 금지), 절대 경로는 그대로. 영문 · 숫자 · `. _ - /` 와 `* ?`. `* ?` 는 `/` 를 넘지 않고 `**` 는 금지, 펼친 경로의 앞 두 폴더는 와일드카드 없이 |
| processes[].iniFiles | | INI 파일 패턴 목록 (선택). 비우면 시작 스크립트 폴더 아래 3단계까지의 `*.ini`. 규칙은 logFiles 와 같고 `.ini` 로 끝나야 합니다 |
| processes[].startScript | | 시작 스크립트 절대 경로 (영문 · 숫자 · `. _ - /`) |
| processes[].autoRestart | | `true` 면 자동 재시작. `startScript` 와, `watchName` · `watchArgs` 중 하나 이상 필요 |
| processes[].watchName | | 감시 프로세스의 실행 파일 이름 (경로 · 공백 없이, 정확히 일치) |
| processes[].watchArgs | | 감시 프로세스 명령줄에 들어 있어야 하는 문자열 (정규식 아님) |

### PUT /api/config

`⚙ 설정` 에서 **저장**을 누르면 호출합니다. 설정 전체를 교체하고, 저장된 설정을 GET 과 같은 형식(새 `version`)으로 돌려줍니다.

- 본문의 `version` 은 설정 창을 열 때 GET 으로 받은 값입니다. 지금 파일의 version 과 다르면(그 사이 **감시** 창, 다른 사용자, 파일 직접 수정으로 바뀌었으면) 덮어쓰지 않고 `409` 입니다. 화면은 설정 창을 열 때마다 최신 설정을 다시 읽습니다.
- 스크립트로 저장할 때도 먼저 GET 으로 받은 `version` 을 넣어야 합니다. (설정 파일이 아직 없으면 빈 값)

| 상태 코드 | 의미 |
|---|---|
| `400` | 형식 오류. 문제를 모두 모아 `{"error": "...\nservers[1].host: ..."}` 로 돌려줌. 알 수 없는 필드도 거부 |
| `409` | 설정 창을 연 뒤 다른 곳에서 설정이 바뀜 |
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
        { "id": "shelter", "instances": [{ "pid": 4321, "cpu": 12.5, "mem": 3.2, "elapsed": "2-01:02:03", "command": "java -jar /opt/shelter/shelter.jar" }],
          "watch": { "healthy": true, "restarts": 1, "lastRestartAt": "2026-11-19T10:02:03+09:00" } }
      ]
    },
    { "id": "uw-db", "error": "ssh ops@10.0.0.12:22 접속 실패: ... connection refused", "checkedAt": "...", "processes": [] }
  ]
}
```

- `instances` 가 비어 있으면 중지된 프로세스입니다.
- `watch` 는 `watchName` 이나 `watchArgs` 를 등록한 프로세스에만 있습니다. `healthy` 감시 프로세스가 지금 있는지, `paused` 화면에서 중지해 자동 재시작이 멈췄는지, `restarts` Go 서버가 켜진 뒤 자동으로 시작한 횟수, `lastRestartAt` 마지막 자동 시작 시각, `lastError` 마지막 자동 시작 · 확인 오류.
- SSH 접속에 실패한 서버는 `error` 에 이유가 들어가고, 나머지 서버의 결과는 그대로 옵니다. (응답은 `200`)
- 없는 그룹이면 `404`

### GET /api/processes/:id/files?root=log

`root`(`log` 로그 파일, 기본값 · `ini` INI 파일)의 패턴에 맞는 파일 목록입니다. 최근 수정 순이며, 폴더는 보여주지 않습니다.
`patterns` 는 실제로 쓴 절대 경로 패턴입니다. (비워 두었으면 시작 스크립트 폴더 기준 기본 패턴, 상대 경로는 펼친 결과)

```json
{
  "patterns": ["/opt/shelter/logs/*.log", "/opt/shelter/logs/*/*.log"],
  "entries": [
    { "path": "/opt/shelter/logs/app.log", "type": "file", "size": 1234, "modified": "Nov 19 11:15" },
    { "path": "/opt/shelter/logs/current.log", "type": "link", "size": 7, "modified": "Nov 18  2025", "target": "app.log" },
    { "path": "/opt/shelter/logs/2026-11/app.log", "type": "file", "size": 4096, "modified": "Nov 18  2025" }
  ],
  "truncated": false
}
```

- `type`: `file` · `link`(심볼릭 링크). `modified` 는 `ls` 가 보여주는 시각 그대로입니다.
- 1000개를 넘으면 최근 것만 주고 `truncated: true` 입니다.
- 맞는 파일이 없는 패턴은 무시합니다. (권한이 없어 못 읽는 폴더도 오류 없이 빠집니다)

| 상태 코드 | 의미 |
|---|---|
| `400` | 쓸 패턴이 없음(시작 스크립트도 패턴도 없음, 시작 스크립트 폴더가 너무 얕음), 알 수 없는 `root` |
| `404` | 없는 프로세스 |
| `502` | SSH 실패 |

### GET /api/processes/:id/log?path=/opt/shelter/logs/app.log&lines=200

로그 파일 패턴에 맞는 `path`(절대 경로) 파일의 마지막 `lines` 줄(1~2000, 기본 200)을 돌려줍니다. 응답 `200` `{"output": "...\n"}`

| 상태 코드 | 의미 |
|---|---|
| `400` | 패턴이 등록되지 않음, `path` 없음, 패턴에 맞지 않거나 `..` · 작은따옴표 · 제어 문자가 들어간 경로 |
| `404` | 없는 프로세스 |
| `502` | SSH 실패 또는 tail 실패 (파일 없음 · 권한 없음 등, 서버의 오류 문구 포함) |

### GET /api/processes/:id/log/download?path=/opt/shelter/logs/app.log

로그 파일 패턴에 맞는 파일 전체를 첨부 파일로 내려받습니다. (`Content-Disposition: attachment`)

- 시작할 때 잰 크기만큼만 보내고 `Content-Length` 로 알려줍니다. (받는 동안 로그가 늘어나도 길이가 맞도록)
- Go 서버는 파일을 메모리에 모으지 않고 SSH 출력을 그대로 흘려보냅니다. 브라우저에서 취소하면 서버 쪽 명령도 멈춥니다.
- 화면의 **⤓ 화면 내용**은 이 API 를 쓰지 않고, 화면에 보이는 줄로 브라우저에서 바로 파일을 만듭니다.
- 보내기 시작한 뒤 실패하면 상태 코드를 바꿀 수 없어 브라우저에는 내려받기 실패로 보입니다. (Go 서버 로그에 남습니다)

| 상태 코드 | 의미 |
|---|---|
| `400` | 패턴이 등록되지 않음, 패턴에 맞지 않는 경로 |
| `404` | 없는 프로세스 |
| `502` | SSH 실패, 파일 없음 · 권한 없음 |

### GET /api/processes/:id/ini?path=/opt/shelter/conf/app.ini

INI 파일 패턴에 맞는 `path`(절대 경로) 파일을 통째로 읽습니다. 응답 `200` `{"content": "...", "hash": "<sha256>"}`

| 상태 코드 | 의미 |
|---|---|
| `400` | 패턴이 등록되지 않음, 패턴에 맞지 않는 경로 |
| `404` | 없는 프로세스 |
| `422` | UTF-8 이 아닌 파일 (EUC-KR 등). 그대로 저장하면 글자가 깨지므로 열지 않습니다 |
| `502` | SSH 실패, 파일 없음 · 권한 없음, 1MB 초과 |

### PUT /api/processes/:id/ini?path=/opt/shelter/conf/app.ini

파일 내용을 바꿉니다. 본문 `{"content": "...", "baseHash": "<읽을 때 받은 hash>"}`, 응답은 GET 과 같은 형식(새 hash)입니다.

- 지금 파일의 hash 가 `baseHash` 와 다르면(연 뒤 다른 곳에서 바뀌었으면) 덮어쓰지 않고 `409` 입니다.
- 바꾸기 전 내용은 같은 폴더의 `<파일>.bak` 에 남깁니다. (매번 덮어씀, 한 단계만 보관)
- 줄바꿈은 받은 그대로 씁니다. 화면은 원래 CRLF 였던 파일을 CRLF 로 되돌려 보냅니다.
- 요청한 IP 와 크기를 서버 로그에 남깁니다.

| 상태 코드 | 의미 |
|---|---|
| `400` | 위 GET 과 같음, 본문 형식 오류 |
| `409` | 연 뒤 다른 곳에서 바뀜, 같은 파일을 저장하는 중 |
| `413` | 1MB 초과 |
| `502` | SSH 실패, 쓰기 권한 없음(폴더에도 쓰기 권한이 필요), 내용을 끝까지 받지 못함 |

### PUT /api/processes/:id/watch

모니터링 화면의 **감시** 창에서 프로세스 하나의 자동 재시작 설정만 바꿉니다. 본문 `{"autoRestart": true, "watchName": "", "watchArgs": "-jar /opt/app/app.jar"}`.
응답은 `GET /api/config` 와 같은 형식의 전체 설정입니다.

| 상태 코드 | 의미 |
|---|---|
| `400` | 감시 조건이 없음, 시작 스크립트가 없음 등 (`"watchArgs: ..."` 형식) |
| `404` | 없는 프로세스 |

### GET /api/processes/:id/watch-test?name=java&args=app.jar

감시 조건(`name` 감시 이름 · `args` 감시 문자열, 하나 이상)에 지금 서버의 ps 에서 맞는 프로세스를 돌려줍니다. 저장 전 확인용입니다. 응답 `200` `{"instances": [{ "pid": 4321, ... }]}`

### POST /api/processes/:id/start · stop · restart

프로세스를 시작 · 중지 · 재시작합니다. 본문은 `{}` 입니다. 응답 `200` `{"message": "중지했습니다 · 시작 명령을 보냈습니다"}`

- **stop**: ps 로 찾은 PID 에 SIGTERM 을 보내고, 사라질 때까지 최대 10초 기다립니다. 이미 중지되어 있으면 `"이미 중지되어 있습니다"`. 자동 재시작을 멈춥니다.
- **start**: 시작 스크립트를 실행합니다. 이미 실행 중이면 `409`
- **restart**: stop 후 start. 중지되어 있었으면 start 만 합니다.
- start · restart 는 멈춘 자동 재시작을 다시 켭니다.
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
| `/all`, `/<그룹 slug>` 등 확장자 없는 경로 | 화면(`index.html`). 그룹 주소에서는 상단 탭 · ⚙ 설정이 그 그룹만 다룹니다 |
| `/config/README.md` | 화면 위 소개 · 사용 방법 |
| `/config/API.md` | 이 문서 |

없는 파일(확장자가 있는 경로), `.ini` · `.map` 파일, `/api` 아래의 없는 경로는 `404` 입니다.

> 로그인이 없으므로 화면에 접속할 수 있는 사람은 누구나 설정을 바꾸고 프로세스를 중지할 수 있습니다. 내부망에서만 열어 두세요.
