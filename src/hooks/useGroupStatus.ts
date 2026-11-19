import { useCallback, useEffect, useRef, useState } from 'react';
import { ServerStatus } from '../config/types';
import { requestApi } from './useProcessConfig';

/**
 * 그룹(slug, "all" 이면 전체)의 서버별 프로세스 상태를 주기적으로 가져온다.
 * 응답이 와야 다음 요청을 잡으므로 느린 서버가 있어도 요청이 겹치지 않는다. 탭이 숨겨져 있으면 건너뛴다.
 */
export function useGroupStatus(slug: string, intervalMs: number, enabled: boolean) {
  /** 서버 id → 상태 */
  const [servers, setServers] = useState<Record<string, ServerStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!document.hidden) {
      setLoading(true);
      try {
        const body = await requestApi<{ servers: ServerStatus[] }>(
          `${process.env.PUBLIC_URL}/api/status?group=${encodeURIComponent(slug)}`,
          { signal: controller.signal }
        );
        setServers(Object.fromEntries(body.servers.map(server => [server.id, server])));
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(`상태를 가져오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      }
      setLoading(false);
    }
    // 다른 refresh 로 대체된 요청은 다음 스케줄을 잡지 않는다. (폴링이 둘로 늘어나지 않도록)
    if (!controller.signal.aborted) timerRef.current = setTimeout(refresh, intervalMs);
  }, [slug, intervalMs]);

  useEffect(() => {
    setServers({});
    if (!enabled) return;
    refresh();
    return () => {
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [refresh, enabled]);

  return { servers, error, loading, refresh };
}
