export interface FetchJsonResult<T> {
  data: T;
  latencyMs: number;
}

/**
 * 모니터링 대상 백엔드에 대한 순수 GET 클라이언트.
 * 엔드포인트마다 호스트가 다르므로(this app 소유의 API가 아님) baseURL 개념 없이
 * ini에 적힌 절대 URL을 그대로 호출한다.
 */
export async function fetchJson<T = unknown>(
  url: string,
  signal?: AbortSignal
): Promise<FetchJsonResult<T>> {
  const startedAt = performance.now();
  let response: Response;

  try {
    response = await fetch(url, { method: 'GET', signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const latencyMs = performance.now() - startedAt;

  if (!response.ok) {
    throw new Error(`http ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as T;
  return { data, latencyMs };
}
