import { useCallback, useEffect, useState } from 'react';
import { validateProcessConfig } from '../config/schema';
import { ProcessConfig } from '../config/types';

const API_URL = `${process.env.PUBLIC_URL}/api/config`;

/**
 * 사이트 API(Go 서버, npm start 에서는 src/setupProxy.js 가 Go 서버로 전달)를 호출한다.
 * 실패하면 서버가 준 에러 문구를 담아 던진다.
 */
export async function requestApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson ? await response.json() : null;
  if (!response.ok) {
    throw new Error(body?.error ?? `http ${response.status} ${response.statusText}`);
  }
  // Go 서버가 꺼져 있으면 개발 서버가 index.html 을 돌려주기도 한다.
  if (!isJson) throw new Error(`${url}: JSON 응답이 아닙니다. Go 서버가 실행 중인지 확인하세요`);
  return body as T;
}

/** 그룹 · 서버 · 프로세스 설정을 읽고 저장한다. */
export function useProcessConfig() {
  /** 아직 못 읽었으면 null */
  const [config, setConfig] = useState<ProcessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = validateProcessConfig(await requestApi(API_URL));
      if (!result.ok) throw new Error(`설정이 올바르지 않습니다\n${result.errors.join('\n')}`);
      setConfig(result.config);
    } catch (e) {
      setConfig(null);
      setError(`설정을 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 서버에 저장하고, 서버가 저장한 내용(비밀번호 제외)으로 화면을 갱신한다. 실패하면 에러를 던진다. */
  const save = useCallback(async (next: ProcessConfig) => {
    setConfig(
      await requestApi<ProcessConfig>(API_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
    );
  }, []);

  return { config, loading, error, reload, save };
}
