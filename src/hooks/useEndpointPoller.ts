import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api/client';
import { EndpointConfig } from '../config/types';

export type EndpointStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface EndpointState {
  status: EndpointStatus;
  data: unknown;
  error: string | null;
  lastUpdatedAt: Date | null;
  latencyMs: number | null;
}

export interface UseEndpointPollerResult extends EndpointState {
  paused: boolean;
  togglePaused: () => void;
  refreshNow: () => void;
}

const INITIAL_STATE: EndpointState = {
  status: 'idle',
  data: null,
  error: null,
  lastUpdatedAt: null,
  latencyMs: null,
};

/**
 * 하나의 엔드포인트를 주기적으로 GET 폴링한다.
 * setInterval 대신 재귀 setTimeout을 사용해, 느린 백엔드에서 요청이
 * 겹쳐 쌓이는 것을 방지한다 (응답이 와야 다음 스케줄을 잡음).
 */
export function useEndpointPoller(config: EndpointConfig): UseEndpointPollerResult {
  const [state, setState] = useState<EndpointState>(INITIAL_STATE);
  const [paused, setPaused] = useState(false);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState(prev => ({ ...prev, status: 'loading' }));

    try {
      const { data, latencyMs } = await fetchJson(config.url, controller.signal);
      if (!mountedRef.current) return;
      setState({ status: 'ok', data, error: null, lastUpdatedAt: new Date(), latencyMs });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (!mountedRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      setState(prev => ({ ...prev, status: 'error', error: message, lastUpdatedAt: new Date() }));
    } finally {
      // 다른 poll()에 의해 대체되었거나 언마운트로 취소된 요청은 다음 스케줄을 잡지 않는다.
      // (잡으면 폴링 체인이 둘로 늘어나 서로의 요청을 계속 abort 하게 됨)
      if (!controller.signal.aborted && mountedRef.current && !pausedRef.current) {
        timerRef.current = setTimeout(poll, config.pollIntervalMs);
      }
    }
  }, [config.url, config.pollIntervalMs]);

  useEffect(() => {
    mountedRef.current = true;
    poll();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll]);

  const togglePaused = useCallback(() => {
    // setState updater 안에서 poll()을 부르면 StrictMode에서 두 번 실행되므로 밖에서 처리한다.
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!next) {
      poll();
    }
  }, [poll]);

  const refreshNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    poll();
  }, [poll]);

  return { ...state, paused, togglePaused, refreshNow };
}
