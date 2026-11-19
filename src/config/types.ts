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
 *                   "logFile": "/opt/shelter/logs/app.log", "startScript": "/opt/shelter/start.sh" }]
 * }
 */
export interface ProcessConfig {
  /** 상태 확인 주기(ms). 없으면 5000 */
  pollIntervalMs?: number;
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
  /** 로그 보기에서 tail 할 파일의 절대 경로 */
  logFile?: string;
  /** 시작 · 재시작 때 실행할 스크립트의 절대 경로 */
  startScript?: string;
}

/** GET /api/status 응답의 서버 하나 */
export interface ServerStatus {
  id: string;
  /** SSH 접속 · ps 실행에 실패한 이유 */
  error?: string;
  checkedAt: string;
  processes: { id: string; instances: ProcessInstance[] }[];
}

export interface ProcessInstance {
  pid: number;
  cpu: number;
  mem: number;
  /** 실행 시간 ([[dd-]hh:]mm:ss) */
  elapsed: string;
  command: string;
}
