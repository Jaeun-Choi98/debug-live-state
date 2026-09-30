import { parseIni } from './iniParser';
import { EndpointConfig } from './types';

const CONFIG_URL = `${process.env.PUBLIC_URL}/config/endpoints.ini`;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const GLOBAL_SECTION = 'global';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * public/config/endpoints.ini 를 매번 새로 fetch 해서 파싱한다.
 * 정적 파일이므로 빌드 없이 수정 후 "Reload Config" 만으로 반영된다.
 */
export async function loadEndpointConfigs(): Promise<EndpointConfig[]> {
  let text: string;
  try {
    const response = await fetch(`${CONFIG_URL}?t=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
    text = await response.text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`설정 파일을 불러오지 못했습니다 (${CONFIG_URL}): ${reason}`);
  }

  const doc = parseIni(text);
  const globalIntervalMs = parsePositiveInt(
    doc[GLOBAL_SECTION]?.['poll_interval_ms'],
    DEFAULT_POLL_INTERVAL_MS
  );

  const endpoints: EndpointConfig[] = [];
  for (const [sectionName, section] of Object.entries(doc)) {
    if (sectionName === GLOBAL_SECTION) continue;

    const url = section['url'];
    if (!url) {
      console.warn(`[config] [${sectionName}] 섹션에 url이 없어 건너뜁니다`);
      continue;
    }

    endpoints.push({
      id: sectionName,
      label: section['label'] || sectionName,
      url,
      pollIntervalMs: parsePositiveInt(section['poll_interval_ms'], globalIntervalMs),
    });
  }

  return endpoints;
}
