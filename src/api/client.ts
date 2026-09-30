export interface FetchJsonResult<T> {
  data: T;
  latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 모니터링 대상 백엔드에 대한 순수 GET 클라이언트.
 * 엔드포인트마다 호스트가 다르므로(this app 소유의 API가 아님) baseURL 개념 없이
 * ini에 적힌 절대 URL을 그대로 호출한다.
 *
 * 연결은 되었지만 응답이 오지 않는 백엔드 때문에 무한 로딩에 빠지지 않도록
 * timeoutMs 가 지나면 요청을 끊고 에러를 던진다 (응답 본문 수신까지 포함).
 */
export async function fetchJson<T = unknown>(
  url: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<FetchJsonResult<T>> {
  // 외부 signal(호출자의 abort)과 타임아웃을 하나의 controller로 합친다.
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = performance.now();

  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    const latencyMs = performance.now() - startedAt;

    if (!response.ok) {
      throw new Error(`http ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as T;
    return { data, latencyMs };
  } catch (e) {
    if (timedOut) {
      throw new Error(`timeout: ${timeoutMs}ms 내에 응답이 없습니다`);
    }
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    if (e instanceof TypeError) {
      // fetch 자체의 네트워크 실패 (연결 거부, CORS 등)
      throw new Error(`network error: ${e.message}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
