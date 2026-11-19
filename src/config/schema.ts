import { ProcessConfig } from './types';

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_WATCH_INTERVAL_MS = 10000;
export const DEFAULT_RESTART_DELAY_MS = 30000;

/** 화면 · 서버의 다른 경로와 겹쳐서 그룹 slug 로 쓸 수 없는 값 */
export const RESERVED_SLUGS = ['all', 'api', 'config', 'static', 'log-config'];

export type ValidationResult = { ok: true; config: ProcessConfig } | { ok: false; errors: string[] };

/**
 * 설정 값을 검사하고, 문제를 하나에서 멈추지 않고 모두 모아서 돌려준다. (불러오기 · 편집 · 가져오기)
 * Go 서버도 저장 전에 같은 규칙으로 다시 검사한다. (go-server/internal/processes/config.go)
 *
 * 에러는 "servers[2].host: ..." 형식이다. 편집 화면이 이 형식에서 문제가 있는 칸을 찾는다.
 */
export function validateProcessConfig(raw: unknown): ValidationResult {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
  // 원격 명령에 그대로 들어가므로 셸 특수문자가 없는 절대 경로만 허용한다. ('..', '//' 도 금지)
  const isSafePath = (value: unknown) =>
    typeof value === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(value) && !/(^|\/)\.\.?(\/|$)|\/\/|.\/$/.test(value);

  if (!isObject(raw)) {
    return { ok: false, errors: ['최상위 값은 객체여야 합니다 ({ "groups": [...], "servers": [...], "processes": [...] })'] };
  }

  const errors: string[] = [];
  const { groups, servers, processes } = raw;
  for (const field of ['pollIntervalMs', 'watchIntervalMs', 'restartDelayMs'] as const) {
    const value = raw[field];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 1000)) {
      errors.push(`${field}: 1000 이상이어야 합니다`);
    }
  }
  if (!Array.isArray(groups) || !Array.isArray(servers) || !Array.isArray(processes)) {
    errors.push('groups, servers, processes: 배열이 필요합니다');
    return { ok: false, errors };
  }

  // 같은 값이 앞에서 나왔으면 중복 에러를 추가한다.
  const checkUnique = (seen: Set<string>, value: unknown, at: string) => {
    if (seen.has(String(value))) errors.push(`${at}: '${value}' 가 중복됩니다`);
    seen.add(String(value));
  };

  const slugs = new Set<string>();
  groups.forEach((group: unknown, i: number) => {
    const at = `groups[${i}]`;
    if (!isObject(group)) return errors.push(`${at}: 객체여야 합니다`);
    if (typeof group.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(group.slug)) {
      errors.push(`${at}.slug: 영문 소문자 · 숫자 · '-' 로 써야 합니다`);
    } else if (RESERVED_SLUGS.includes(group.slug)) {
      errors.push(`${at}.slug: '${group.slug}' 는 쓸 수 없습니다`);
    } else {
      checkUnique(slugs, group.slug, `${at}.slug`);
    }
    if (!isText(group.name)) errors.push(`${at}.name: 비어 있습니다`);
  });

  const serverIds = new Set<string>();
  servers.forEach((server: unknown, i: number) => {
    const at = `servers[${i}]`;
    if (!isObject(server)) return errors.push(`${at}: 객체여야 합니다`);
    if (!isText(server.id)) errors.push(`${at}.id: 비어 있습니다`);
    else checkUnique(serverIds, server.id, `${at}.id`);
    if (!slugs.has(String(server.group))) errors.push(`${at}.group: 등록된 그룹이 아닙니다`);
    if (typeof server.host !== 'string' || !/^[A-Za-z0-9.:-]+$/.test(server.host)) {
      errors.push(`${at}.host: 호스트 이름이나 IP 가 필요합니다`);
    }
    if (server.port !== undefined && !(Number.isInteger(server.port) && (server.port as number) >= 1 && (server.port as number) <= 65535)) {
      errors.push(`${at}.port: 1~65535 사이여야 합니다`);
    }
    if (!isText(server.user)) errors.push(`${at}.user: 비어 있습니다`);
    if (!isText(server.password) && server.hasPassword !== true) errors.push(`${at}.password: 비어 있습니다`);
  });

  const processIds = new Set<string>();
  processes.forEach((process: unknown, i: number) => {
    const at = `processes[${i}]`;
    if (!isObject(process)) return errors.push(`${at}: 객체여야 합니다`);
    if (!isText(process.id)) errors.push(`${at}.id: 비어 있습니다`);
    else checkUnique(processIds, process.id, `${at}.id`);
    if (!serverIds.has(String(process.server))) errors.push(`${at}.server: 등록된 서버가 아닙니다`);

    let validPattern = isText(process.match);
    try {
      if (validPattern) new RegExp(process.match as string);
    } catch {
      validPattern = false;
    }
    if (!validPattern) errors.push(`${at}.match: 올바른 정규식이 필요합니다`);

    for (const field of ['logDir', 'configDir', 'startScript'] as const) {
      if (process[field] !== undefined && !isSafePath(process[field])) {
        errors.push(`${at}.${field}: 영문 · 숫자 · . _ - / 로 된 절대 경로가 필요합니다`);
      }
    }

    if (process.autoRestart !== undefined && typeof process.autoRestart !== 'boolean') {
      errors.push(`${at}.autoRestart: true 또는 false 여야 합니다`);
    }
    if (process.watchName !== undefined && !(typeof process.watchName === 'string' && /^[^/\s]+$/.test(process.watchName))) {
      errors.push(`${at}.watchName: 경로 · 공백 없는 실행 파일 이름이 필요합니다 (예: java)`);
    }
    if (process.watchArgs !== undefined && typeof process.watchArgs !== 'string') {
      errors.push(`${at}.watchArgs: 문자열이어야 합니다`);
    } else if (process.autoRestart === true && process.watchName === undefined && process.watchArgs === undefined) {
      errors.push(`${at}.watchArgs: 자동 재시작에는 감시 이름이나 감시 문자열이 필요합니다`);
    }
    if (process.autoRestart === true && process.startScript === undefined) {
      errors.push(`${at}.startScript: 자동 재시작에는 시작 스크립트가 필요합니다`);
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: raw as unknown as ProcessConfig };
}
