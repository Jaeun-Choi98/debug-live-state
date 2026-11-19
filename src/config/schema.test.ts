import { checkFilePattern, effectivePatterns, validateProcessConfig } from './schema';

const valid = {
  pollIntervalMs: 5000,
  groups: [{ slug: 'uw', name: '의왕' }],
  servers: [{ id: 'uw-app1', group: 'uw', host: '10.0.0.11', port: 22, user: 'ops', hasPassword: true }],
  processes: [
    {
      id: 'shelter',
      server: 'uw-app1',
      match: 'java .*shelter\\.jar',
      logFiles: ['/opt/shelter/logs/*.log', '/opt/shelter/logs/*/*.log'],
      iniFiles: ['/opt/shelter/conf/*.ini'],
      startScript: '/opt/shelter/start.sh',
      autoRestart: true,
      watchName: 'java',
      watchArgs: '/opt/shelter/shelter.jar',
    },
  ],
};

test('accepts a valid config (saved password counts as password)', () => {
  expect(validateProcessConfig(valid)).toEqual({ ok: true, config: valid });
});

test('collects every error with its location', () => {
  const result = validateProcessConfig({
    pollIntervalMs: 10,
    watchIntervalMs: 500,
    restartDelayMs: 1.5,
    groups: [{ slug: 'uw', name: '의왕' }, { slug: 'all', name: 'x' }, { slug: 'uw', name: '' }],
    servers: [{ id: 'a', group: 'nope', host: 'bad host', port: 0, user: '' }],
    processes: [
      { id: 'p', server: 'zzz', match: '(', logFiles: ['/home/*'], startScript: 'start.sh; rm -rf /', watchName: '/usr/bin/java' },
      { id: 'q', server: 'zzz', match: 'java', autoRestart: true },
    ],
  });
  expect(result.ok).toBe(false);
  const fields = result.ok ? [] : result.errors.map(error => error.split(':')[0]);
  expect(fields).toEqual([
    'pollIntervalMs',
    'watchIntervalMs',
    'restartDelayMs',
    'groups[1].slug',
    'groups[2].slug',
    'groups[2].name',
    'servers[0].group',
    'servers[0].host',
    'servers[0].port',
    'servers[0].user',
    'servers[0].password',
    'processes[0].server',
    'processes[0].match',
    'processes[0].startScript',
    'processes[0].logFiles',
    'processes[0].watchName',
    'processes[1].server',
    'processes[1].watchArgs',
    'processes[1].startScript',
  ]);
});

test('rejects a non-object root and missing arrays', () => {
  expect(validateProcessConfig([])).toEqual({ ok: false, errors: [expect.stringContaining('최상위')] });
  expect(validateProcessConfig({ groups: [] })).toEqual({ ok: false, errors: ['groups, servers, processes: 배열이 필요합니다'] });
});

test('file patterns follow the same rules as the Go server', () => {
  for (const ok of ['/opt/app/logs/*.log', '/opt/app/logs/*', '/opt/app/logs/*/*.log', '/opt/app.log', '/home/user/app-?.log']) {
    expect(checkFilePattern(ok, false)).toBe('');
  }
  for (const bad of ['/home/*', '/*/app.log', '/opt/*/x.log', '/opt/app/**', '/opt/../etc/x.log', 'opt/app/x.log', '/opt/app/x y.log', '/opt']) {
    expect(checkFilePattern(bad, false)).not.toBe('');
  }
  expect(checkFilePattern('/opt/app/conf/*.ini', true)).toBe('');
  expect(checkFilePattern('/opt/app/conf/*', true)).not.toBe('');
});

test('file patterns default to the start script folder and resolve relative paths', () => {
  expect(effectivePatterns({ startScript: '/opt/shelter/start.sh' }, 'log').patterns).toEqual([
    '/opt/shelter/*.log',
    '/opt/shelter/*/*.log',
    '/opt/shelter/*/*/*.log',
    '/opt/shelter/*/*/*/*.log',
    '/opt/shelter/*/*/*/*/*.log',
  ]);
  expect(effectivePatterns({ startScript: '/opt/shelter/start.sh', iniFiles: ['conf/*.ini', '/etc/shelter/*.ini'] }, 'ini').patterns).toEqual([
    '/opt/shelter/conf/*.ini',
    '/etc/shelter/*.ini',
  ]);
  expect(effectivePatterns({}, 'log').problem).toBeTruthy();
  expect(effectivePatterns({ startScript: '/opt/start.sh' }, 'log').problem).toBeTruthy();

  const config = (process: object) => ({
    groups: [{ slug: 'uw', name: '의왕' }],
    servers: [{ id: 's', group: 'uw', host: 'h', user: 'u', hasPassword: true }],
    processes: [{ id: 'p', server: 's', match: 'x', ...process }],
  });
  expect(validateProcessConfig(config({ startScript: '/opt/shelter/start.sh', logFiles: ['logs/*.log'] })).ok).toBe(true);
  expect(validateProcessConfig(config({ logFiles: ['logs/*.log'] })).ok).toBe(false);
  expect(validateProcessConfig(config({ startScript: '/opt/shelter/start.sh', logFiles: ['../etc/*.log'] })).ok).toBe(false);
});
