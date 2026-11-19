import { validateEndpointsFile } from './schema';

const valid = {
  pollIntervalMs: 2000,
  endpoints: [
    { id: 'a', group: 'G', label: 'A', url: 'http://localhost:8081/state', pollIntervalMs: 500 },
    { id: 'b', url: 'https://example.com/state' },
  ],
};

describe('validateEndpointsFile', () => {
  it('accepts a valid file', () => {
    expect(validateEndpointsFile(valid)).toEqual({ ok: true, file: valid });
  });

  it('collects every problem instead of stopping at the first', () => {
    const result = validateEndpointsFile({
      pollIntervalMs: 0,
      endpoints: [
        { id: 'a', url: 'ftp://x' },
        { id: 'a', url: 'http://x', pollIntervalMs: 1.5 },
        { id: ' ', url: 'not a url', group: 3 },
      ],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'pollIntervalMs: 1 이상의 정수여야 합니다',
        'endpoints[0].url: http:// 또는 https:// 로 시작하는 주소가 필요합니다',
        "endpoints[1].id: 'a' 가 중복됩니다",
        'endpoints[1].pollIntervalMs: 1 이상의 정수여야 합니다',
        'endpoints[2].id: 비어 있습니다',
        'endpoints[2].url: http:// 또는 https:// 로 시작하는 주소가 필요합니다',
        'endpoints[2].group: 문자열이어야 합니다',
      ],
    });
  });

  it('rejects non-object roots and missing endpoints', () => {
    expect(validateEndpointsFile([]).ok).toBe(false);
    expect(validateEndpointsFile({})).toEqual({ ok: false, errors: ['endpoints: 배열이 필요합니다'] });
  });
});
