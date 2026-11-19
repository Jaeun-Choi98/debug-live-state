/**
 * 설정 파일(processes.json)의 구조. Go 서버의 internal/processes/config.go 와 맞춘다.
 *
 *   그룹(groups) ─┬─ 서버(servers, group = 그룹 slug) ─┬─ 프로세스(processes, server = 서버 id)
 *
 * {
 *   "pollIntervalMs": 5000,
 *   "groups":    [{ "slug": "uw", "name": "의왕" }],
 *   "servers":   [{ "id": "uw-app1", "group": "uw", "label": "의왕 APP 1", "host": "10.0.0.11", "port": 22, "user": "ops", "hasPassword": true }],
 *   "processes": [{ "id": "shelter", "server": "uw-app1", "label": "Shelter", "match": "java .*shelter\\.jar",
 *                   "logDir": "/opt/shelter/logs", "startScript": "/opt/shelter/start.sh",
 *                   "autoRestart": true, "watchName": "java", "watchArgs": "/opt/shelter/shelter.jar" }]
 * }
 */
export interface ProcessConfig {
  /** 상태 확인 주기(ms). 없으면 5000 */
  pollIntervalMs?: number;
  /** 자동 재시작 확인 주기(ms). 없으면 10000 */
  watchIntervalMs?: number;
  /** 시작한 뒤 프로세스가 뜨기를 기다리는 시간(ms). 이 시간 안에는 다시 자동 시작하지 않는다. 없으면 30000 */
  restartDelayMs?: number;
  /** 배열 순서가 화면 표시 순서 */
  groups: GroupEntry[];
  servers: ServerEntry[];
  processes: ProcessEntry[];
}

export interface GroupEntry {
  /** URL 경로 (/uw). 영문 소문자 · 숫자 · '-' */
  slug: string;
  /** 화면 표시 이름 (의왕) */
  name: string;
}

export interface ServerEntry {
  id: string;
  /** 그룹 slug */
  group: string;
  /** 화면 표시 이름 (없으면 id) */
  label?: string;
  host: string;
  /** 없으면 22 */
  port?: number;
  user: string;
  /** 쓰기 전용. 저장할 때만 보내고, 비워 두면 서버가 기존 비밀번호를 유지한다. */
  password?: string;
  /** 조회 전용. 서버에 비밀번호가 저장되어 있으면 true */
  hasPassword?: boolean;
}

export interface ProcessEntry {
  id: string;
  /** 서버 id */
  server: string;
  /** 화면 표시 이름 (없으면 id) */
  label?: string;
  /** ps 명령줄에 대한 정규식. 맞는 프로세스가 있으면 실행 중으로 본다. */
  match: string;
  /** 로그 폴더의 절대 경로. 로그 보기에서 이 폴더 아래를 둘러보고 파일을 tail 로 본다. */
  logDir?: string;
  /** 설정(INI) 폴더의 절대 경로. INI 버튼으로 이 폴더 아래의 *.ini 파일을 읽고 고친다. */
  configDir?: string;
  /** 시작 · 재시작 때 실행할 스크립트의 절대 경로 */
  startScript?: string;
  /**
   * 자동 재시작. 감시 프로세스가 ps 에 없으면 Go 서버가 시작 스크립트를 실행한다. (watchName 이나 watchArgs, startScript 필요)
   * 이 값과 watchName · watchArgs 는 설정 창이 아니라 모니터링 화면의 '감시' 에서 바꾼다. (PUT /api/processes/:id/watch)
   */
  autoRestart?: boolean;
  /** 감시 프로세스의 실행 파일 이름. ps 명령줄 첫 단어의 파일 이름과 정확히 같아야 한다. (예: java, 비우면 문자열만 본다) */
  watchName?: string;
  /** 감시 프로세스의 명령줄에 들어 있어야 하는 문자열. 정규식이 아니다. (예: /opt/app/app.jar, 비우면 이름만 본다) */
  watchArgs?: string;
}

/** GET /api/status 응답의 서버 하나 */
export interface ServerStatus {
  id: string;
  /** SSH 접속 · ps 실행에 실패한 이유 */
  error?: string;
  checkedAt: string;
  processes: { id: string; instances: ProcessInstance[]; watch?: WatchStatus }[];
}

/** 감시 조건(watchName · watchArgs)을 등록한 프로세스의 감시 · 자동 재시작 상태. Go 서버 메모리에만 있다. */
export interface WatchStatus {
  /** 감시 프로세스가 지금 ps 에 있는지 */
  healthy: boolean;
  /** 화면에서 중지해 자동 재시작이 멈춘 상태. 시작 · 재시작하면 다시 켜진다. */
  paused?: boolean;
  /** Go 서버가 켜진 뒤 자동으로 시작한 횟수 */
  restarts: number;
  lastRestartAt?: string;
  lastError?: string;
}

/** GET /api/processes/:id/ini 응답. hash 는 저장할 때 baseHash 로 돌려보내 그 사이 바뀌었는지 확인한다. */
export interface IniFile {
  content: string;
  hash: string;
}

/** GET /api/processes/:id/files 응답 */
export interface FileList {
  /** 로그 폴더 기준 상대 경로 ('' 이면 로그 폴더) */
  path: string;
  /** 폴더가 먼저, 그 안에서는 최근 수정 순 */
  entries: FileEntry[];
  /** 항목이 너무 많아 오래된 것을 잘랐는지 */
  truncated?: boolean;
}

export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** ls 가 보여주는 수정 시각 ("Nov 19 11:15") */
  modified: string;
  /** 심볼릭 링크가 가리키는 경로 */
  target?: string;
}

export interface ProcessInstance {
  pid: number;
  cpu: number;
  mem: number;
  /** 실행 시간 ([[dd-]hh:]mm:ss) */
  elapsed: string;
  command: string;
}
