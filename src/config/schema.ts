import { EndpointsFile } from './types';

export const DEFAULT_POLL_INTERVAL_MS = 3000;

export type ValidationResult = { ok: true; file: EndpointsFile } | { ok: false; errors: string[] };

/**
 * 설정 값을 검사하고, 문제를 하나에서 멈추지 않고 모두 모아서 돌려준다. (불러오기 · 편집 · 가져오기)
 * Go 서버도 저장 전에 같은 규칙으로 다시 검사한다. (go-server/internal/endpoints/store.go)
 *
 * 에러는 "endpoints[2].url: ..." 형식이다. 편집 화면이 이 형식에서 문제가 있는 칸을 찾는다.
 */
export function validateEndpointsFile(raw: unknown): ValidationResult {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  // 주기는 생략하거나(기본값 사용) 1 이상의 정수여야 한다.
  const isBadInterval = (value: unknown) => value !== undefined && !(Number.isInteger(value) && (value as number) > 0);

  if (!isObject(raw)) {
    return { ok: false, errors: ['최상위 값은 객체여야 합니다 ({ "endpoints": [...] })'] };
  }

  const errors: string[] = [];
  if (isBadInterval(raw.pollIntervalMs)) {
    errors.push('pollIntervalMs: 1 이상의 정수여야 합니다');
  }
  if (!Array.isArray(raw.endpoints)) {
    errors.push('endpoints: 배열이 필요합니다');
    return { ok: false, errors };
  }

  const seenIds = new Set<string>();
  raw.endpoints.forEach((entry: unknown, i: number) => {
    const at = `endpoints[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${at}: 객체여야 합니다`);
      return;
    }
    const { id, url, group, label, pollIntervalMs } = entry;

    if (typeof id !== 'string' || id.trim() === '') errors.push(`${at}.id: 비어 있습니다`);
    else if (seenIds.has(id)) errors.push(`${at}.id: '${id}' 가 중복됩니다`);
    else seenIds.add(id);

    let protocol = '';
    try {
      protocol = new URL(String(url)).protocol;
    } catch {
      // 주소 형식이 아니면 protocol 이 비어 있어 아래에서 걸린다.
    }
    if (typeof url !== 'string' || (protocol !== 'http:' && protocol !== 'https:')) {
      errors.push(`${at}.url: http:// 또는 https:// 로 시작하는 주소가 필요합니다`);
    }

    if (group !== undefined && typeof group !== 'string') errors.push(`${at}.group: 문자열이어야 합니다`);
    if (label !== undefined && typeof label !== 'string') errors.push(`${at}.label: 문자열이어야 합니다`);
    if (isBadInterval(pollIntervalMs)) errors.push(`${at}.pollIntervalMs: 1 이상의 정수여야 합니다`);
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, file: raw as unknown as EndpointsFile };
}
