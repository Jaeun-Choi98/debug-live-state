import { EndpointConfig } from './types';

const UNGROUPED_NAME = '미분류';

export interface EndpointGroup {
  /** 빈 문자열이면 그룹을 쓰지 않는 설정이다. (그룹 제목 없이 표시) */
  name: string;
  endpoints: EndpointConfig[];
}

/**
 * 엔드포인트를 group 값으로 묶는다. (대시보드 카드 · 사이드바가 같이 쓴다)
 * - 그룹 순서는 설정 파일에 처음 나온 순서를 따른다.
 * - group 이 없는 엔드포인트는 맨 뒤 "미분류" 그룹에 모은다.
 * - 아무도 group 을 쓰지 않으면 이름 없는 그룹 하나만 돌려준다.
 */
export function groupEndpoints(endpoints: EndpointConfig[]): EndpointGroup[] {
  if (endpoints.every(e => e.group === '')) return [{ name: '', endpoints }];

  const groups = new Map<string, EndpointConfig[]>();
  for (const endpoint of endpoints) {
    const name = endpoint.group || UNGROUPED_NAME;
    groups.set(name, [...(groups.get(name) ?? []), endpoint]);
  }
  return Array.from(groups, ([name, list]) => ({ name, endpoints: list })).sort(
    (a, b) => Number(a.name === UNGROUPED_NAME) - Number(b.name === UNGROUPED_NAME)
  );
}
