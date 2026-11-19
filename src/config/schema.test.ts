import { validateProcessConfig } from './schema';

const valid = {
  pollIntervalMs: 5000,
  groups: [{ slug: 'uw', name: '의왕' }],
  servers: [{ id: 'uw-app1', group: 'uw', host: '10.0.0.11', port: 22, user: 'ops', hasPassword: true }],
  processes: [
    {
      id: 'shelter',
      server: 'uw-app1',
      match: 'java .*shelter\\.jar',
      logDir: '/opt/shelter/logs',
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
      { id: 'p', server: 'zzz', match: '(', logDir: '/var/log/../shadow', startScript: 'start.sh; rm -rf /', watchName: '/usr/bin/java' },
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
    'processes[0].logDir',
    'processes[0].startScript',
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
