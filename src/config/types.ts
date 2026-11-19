/**
 * 설정 파일(endpoints.json)의 구조. Go 서버의 internal/endpoints/store.go 와 맞춘다.
 *
 * {
 *   "pollIntervalMs": 3000,
 *   "endpoints": [
 *     { "id": "order-engine", "group": "Trading", "label": "Order Engine", "url": "http://...", "pollIntervalMs": 1000 }
 *   ]
 * }
 */
export interface EndpointsFile {
  /** 엔드포인트별 pollIntervalMs 가 없을 때 쓰는 기본 폴링 주기 */
  pollIntervalMs?: number;
  /** 배열 순서가 화면 표시 순서 */
  endpoints: EndpointEntry[];
}

export interface EndpointEntry {
  /** 고유 id */
  id: string;
  /** 묶어서 보여줄 그룹(컨테이너/프로젝트) 이름 */
  group?: string;
  /** 화면에 표시할 이름 (없으면 id) */
  label?: string;
  /** 항상 GET 으로 호출하며, 응답 JSON 전체를 그대로 표시한다 */
  url: string;
  pollIntervalMs?: number;
}

/** 화면에서 쓰는, 기본값이 채워진 엔드포인트 */
export interface EndpointConfig {
  id: string;
  label: string;
  /** 그룹이 없으면 빈 문자열 */
  group: string;
  url: string;
  pollIntervalMs: number;
}
