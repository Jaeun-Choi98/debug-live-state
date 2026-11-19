import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_POLL_INTERVAL_MS, validateEndpointsFile } from '../config/schema';
import { EndpointConfig, EndpointsFile } from '../config/types';

/** 설정 API. 배포에서는 Go 서버가, npm start 에서는 개발 서버(src/setupProxy.js)가 제공한다. */
const API_URL = `${process.env.PUBLIC_URL}/api/config`;
/** 설정 API 가 없는 곳(정적 호스팅)에서 읽는 기본 설정. 이때는 저장할 수 없다. */
const STATIC_URL = `${process.env.PUBLIC_URL}/config/endpoints.json`;

/** 설정을 요청하고 검사한다. 실패하면 이유를 담은 에러를 던진다. */
async function requestConfig(url: string, init?: RequestInit): Promise<EndpointsFile> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const body: unknown = isJson ? await response.json() : null;

  if (!response.ok) {
    const detail = (body as { error?: string } | null)?.error;
    throw new Error(`${url}: http ${response.status}${detail ? `\n${detail}` : ''}`);
  }
  // 설정 API 가 없으면 서버가 index.html 을 돌려주기도 한다.
  if (!isJson) throw new Error(`${url}: JSON 응답이 아닙니다`);

  const result = validateEndpointsFile(body);
  if (!result.ok) throw new Error(`${url}: 설정이 올바르지 않습니다\n${result.errors.join('\n')}`);
  return result.file;
}

/** 엔드포인트 설정을 읽고 저장한다. */
export function useEndpointsConfig() {
  /** 설정 파일 원본 (편집 화면용). 아직 못 읽었으면 null */
  const [file, setFile] = useState<EndpointsFile | null>(null);
  /** 설정 API 에서 읽었으면 true (저장 가능) */
  const [editable, setEditable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      try {
        setFile(await requestConfig(API_URL));
        setEditable(true);
      } catch (apiError) {
        console.info(`[config] 설정 API 를 쓸 수 없어 ${STATIC_URL} 을 읽기 전용으로 읽습니다:`, apiError);
        setFile(await requestConfig(STATIC_URL));
        setEditable(false);
      }
    } catch (e) {
      setFile(null);
      setError(`설정을 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 서버에 저장하고, 서버가 저장한 내용으로 화면을 갱신한다. 실패하면 에러를 던진다. */
  const save = useCallback(async (next: EndpointsFile) => {
    const saved = await requestConfig(API_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    setFile(saved);
  }, []);

  /** 화면 표시용. 빈 값에 기본값을 채운다. (표시 이름 → id, 그룹 → 없음, 주기 → 파일 기본값 → 3000ms) */
  const endpoints = useMemo<EndpointConfig[]>(() => {
    if (!file) return [];
    const defaultInterval = file.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    return file.endpoints.map(entry => ({
      id: entry.id,
      label: entry.label || entry.id,
      group: entry.group ?? '',
      url: entry.url,
      pollIntervalMs: entry.pollIntervalMs ?? defaultInterval,
    }));
  }, [file]);

  return { file, endpoints, editable, loading, error, reload, save };
}
