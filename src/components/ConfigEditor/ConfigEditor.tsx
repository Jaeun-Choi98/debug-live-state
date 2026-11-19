import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_RESTART_DELAY_MS, DEFAULT_WATCH_INTERVAL_MS, validateProcessConfig } from '../../config/schema';
import { ProcessConfig, ServerEntry } from '../../config/types';
import './ConfigEditor.css';

interface ConfigEditorProps {
  config: ProcessConfig;
  /**
   * 'all' 이면 전체 편집. 그룹 slug 면 그 그룹 편집: 그룹 표 · 주기 설정 · 가져오기/내보내기를 숨기고,
   * 그 그룹의 서버와 그 서버들의 프로세스만 보여준다. 다른 그룹의 행은 손대지 않고 그대로 저장한다.
   */
  scope: string;
  /** 실패하면 에러를 던진다. */
  onSave: (config: ProcessConfig) => Promise<void>;
  onClose: () => void;
}

type Section = 'groups' | 'servers' | 'processes';

/**
 * 편집 중인 한 행. 입력칸 값을 문자열 그대로 들고 있다가 검사 · 저장할 때 변환한다. (autoRestart 는 'true' / '')
 * key 는 React 용이다. (id 는 편집되므로 key 로 쓸 수 없다)
 * 프로세스의 autoRestart · watchName · watchArgs 는 모니터링 화면에서 바꾸므로 열은 없지만,
 * 저장할 때 지워지지 않도록 행에 그대로 들고 있다.
 */
type Row = Record<string, string>;

interface Column {
  field: string;
  title: string;
  placeholder?: string;
  type?: 'number' | 'password' | 'select';
  className?: string;
}

/** 표 세 개의 열 정의. 서버의 group, 프로세스의 server 는 위 표에 있는 값 중에서 고른다. */
const SECTIONS: { section: Section; title: string; description: string; columns: Column[] }[] = [
  {
    section: 'groups',
    title: '그룹',
    description: 'slug 는 화면 주소(/uw)로, 이름은 상단 탭에 쓰입니다.',
    columns: [
      { field: 'slug', title: 'slug *', placeholder: 'uw' },
      { field: 'name', title: '이름 *', placeholder: '의왕' },
    ],
  },
  {
    section: 'servers',
    title: '서버',
    description: 'SSH 비밀번호는 서버 파일에만 저장되고 화면에는 다시 보이지 않습니다. 바꿀 때만 입력하세요. host · port · user 를 바꾸면 다시 입력해야 합니다.',
    columns: [
      { field: 'id', title: 'id *' },
      { field: 'group', title: '그룹 *', type: 'select' },
      { field: 'label', title: '표시 이름' },
      { field: 'host', title: 'host *', placeholder: '10.0.0.11', className: 'config-editor-col-wide' },
      { field: 'port', title: 'port', placeholder: '22', type: 'number', className: 'config-editor-col-narrow' },
      { field: 'user', title: 'user *', placeholder: 'ops' },
      { field: 'password', title: '비밀번호 *', type: 'password' },
    ],
  },
  {
    section: 'processes',
    title: '프로세스',
    description:
      'match 는 화면에 보여줄 프로세스를 찾는 ps 명령줄 정규식입니다. 시작 스크립트는 셸 특수문자가 없는 절대 경로로 적습니다. ' +
      '로그 · INI 파일은 비워 두면 시작 스크립트 폴더 아래의 *.log(4단계) · *.ini(3단계)를 찾습니다. ' +
      '다른 곳을 보려면 패턴을 적습니다: 상대 경로(logs/*.log)는 시작 스크립트 폴더 기준, 절대 경로는 그대로. 여러 개는 쉼표로 나누고, * ? 는 폴더(/)를 넘지 않습니다. ' +
      '자동 재시작과 감시 문자열은 모니터링 화면의 각 프로세스 [감시] 에서 바꿉니다.',
    columns: [
      { field: 'id', title: 'id *' },
      { field: 'server', title: '서버 *', type: 'select' },
      { field: 'label', title: '표시 이름' },
      { field: 'match', title: 'match (정규식) *', placeholder: 'java .*app\\.jar', className: 'config-editor-col-wide' },
      { field: 'startScript', title: '시작 스크립트', placeholder: '/opt/app/start.sh', className: 'config-editor-col-wide' },
      { field: 'logFiles', title: '로그 파일 (선택)', placeholder: '비우면 시작 스크립트 폴더의 *.log', className: 'config-editor-col-wide' },
      { field: 'iniFiles', title: 'INI 파일 (선택)', placeholder: '비우면 시작 스크립트 폴더의 *.ini', className: 'config-editor-col-wide' },
    ],
  },
];

/** 쉼표로 나눈 패턴 칸 → 배열 (비면 생략) */
const patternList = (value: string) => {
  const patterns = value.split(',').map(p => p.trim()).filter(Boolean);
  return patterns.length > 0 ? patterns : undefined;
};

// 예전 설정 파일을 가져올 때 폴더 · 파일 하나를 패턴으로 바꾼다. (Go 서버의 migrateLogFile 과 같은 규칙)
//   logDir /a/logs → /a/logs/*, /a/logs/*/*   configDir /a/conf → /a/conf/*.ini, /a/conf/*/*.ini   logFile → 그대로
const legacyPatterns = (process: object) => {
  const { logDir, configDir, logFile } = process as { logDir?: string; configDir?: string; logFile?: string };
  return {
    logFiles: logDir ? [`${logDir}/*`, `${logDir}/*/*`] : logFile ? [logFile] : [],
    iniFiles: configDir ? [`${configDir}/*.ini`, `${configDir}/*/*.ini`] : [],
  };
};

const SECTION_TITLE: Record<Section, string> = { groups: '그룹', servers: '서버', processes: '프로세스' };

let nextRowKey = 0;

const toRows = (config: ProcessConfig): Record<Section, Row[]> => ({
  groups: config.groups.map(g => ({ key: String(nextRowKey++), slug: g.slug, name: g.name })),
  servers: config.servers.map(s => ({
    key: String(nextRowKey++),
    id: s.id,
    group: s.group,
    label: s.label ?? '',
    host: s.host,
    port: s.port?.toString() ?? '',
    user: s.user,
    password: s.password ?? '',
  })),
  processes: config.processes.map(p => ({
    key: String(nextRowKey++),
    id: p.id,
    server: p.server,
    label: p.label ?? '',
    match: p.match,
    logFiles: (p.logFiles ?? legacyPatterns(p).logFiles).join(', '),
    iniFiles: (p.iniFiles ?? legacyPatterns(p).iniFiles).join(', '),
    startScript: p.startScript ?? '',
    autoRestart: p.autoRestart ? 'true' : '',
    watchName: p.watchName ?? '',
    watchArgs: p.watchArgs ?? '',
  })),
});

/** 위쪽 주기 · 대기 시간 칸. 설정 필드 이름 → 입력칸 값 */
type TimingField = 'pollIntervalMs' | 'watchIntervalMs' | 'restartDelayMs';
const TIMING_FIELDS: { field: TimingField; title: string; fallback: number; help: string }[] = [
  { field: 'pollIntervalMs', title: '상태 확인 주기(ms)', fallback: DEFAULT_POLL_INTERVAL_MS, help: '화면이 상태를 다시 읽는 간격' },
  { field: 'watchIntervalMs', title: '자동 재시작 확인 주기(ms)', fallback: DEFAULT_WATCH_INTERVAL_MS, help: 'Go 서버가 감시 프로세스를 확인하는 간격' },
  {
    field: 'restartDelayMs',
    title: '재시작 대기(ms)',
    fallback: DEFAULT_RESTART_DELAY_MS,
    help: '시작한 뒤 프로세스가 뜨기를 기다리는 시간. 이 시간 안에는 다시 자동 시작하지 않습니다',
  },
];
const toTiming = (config: ProcessConfig): Record<TimingField, string> => ({
  pollIntervalMs: config.pollIntervalMs?.toString() ?? '',
  watchIntervalMs: config.watchIntervalMs?.toString() ?? '',
  restartDelayMs: config.restartDelayMs?.toString() ?? '',
});

/**
 * "servers[2].host: ..." → "서버 3번째 행 host: ..."
 * rowNumber 는 전체 배열의 위치를 화면에 보이는 행 번호로 바꾼다. (그룹 편집에서는 보이는 행만 센다, 안 보이면 null)
 */
const toRowMessage = (message: string, rowNumber: (section: Section, index: number) => number | null = (_, i) => i + 1) =>
  message.replace(/^(groups|servers|processes)\[(\d+)\]\.?/, (_, section: Section, i: string) => {
    const n = rowNumber(section, Number(i));
    return n === null ? `${SECTION_TITLE[section]} (다른 그룹) ` : `${SECTION_TITLE[section]} ${n}번째 행 `;
  });

/** ⚙ 설정: 그룹 · 서버 · 프로세스를 추가 · 삭제 · 수정 · 정렬하고, JSON 파일로 가져오거나 내보내고, 서버에 저장한다. */
const ConfigEditor: React.FC<ConfigEditorProps> = ({ config, scope, onSave, onClose }) => {
  const groupMode = scope !== 'all';
  /** 위쪽 숫자 칸 (빈 칸이면 기본값) */
  const [timing, setTiming] = useState(() => toTiming(config));
  /**
   * 창을 열 때의 설정 version. 저장할 때 보내서, 그 사이 감시 창 · 다른 사용자가 바꾼 내용을 덮어쓰지 않게 한다.
   * (창이 열린 동안 config 가 새로 들어와도 이 값은 바꾸지 않는다)
   */
  const [baseVersion] = useState(config.version);
  const [rows, setRows] = useState<Record<Section, Row[]>>(() => toRows(config));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  /** 서버에 저장되어 있는 서버 정보 (비밀번호가 저장되어 있는지 판단용) */
  const savedServers = useMemo(() => new Map(config.servers.map(s => [s.id, s])), [config.servers]);
  /** 비밀번호를 비워 둬도 서버가 기존 비밀번호를 유지하는지. (같은 id 에 host · port · user 가 그대로일 때만) */
  const keepsPassword = (row: Row) => {
    const saved: ServerEntry | undefined = savedServers.get(row.id.trim());
    return Boolean(
      saved?.hasPassword &&
        saved.host === row.host.trim() &&
        (saved.port ?? 22) === (Number(row.port) || 22) &&
        saved.user === row.user.trim()
    );
  };

  // 입력칸 값을 설정 파일 형태로 바꿔 검사한다.
  // 빈 칸은 생략(기본값 사용)하고, 숫자가 아닌 값은 NaN 으로 두어 검사에 걸리게 한다.
  const validation = useMemo(() => {
    const text = (value: string) => value.trim() || undefined;
    const number = (value: string) => (value.trim() === '' ? undefined : Number(value));
    return validateProcessConfig({
      pollIntervalMs: number(timing.pollIntervalMs),
      watchIntervalMs: number(timing.watchIntervalMs),
      restartDelayMs: number(timing.restartDelayMs),
      groups: rows.groups.map(r => ({ slug: r.slug.trim(), name: r.name.trim() })),
      servers: rows.servers.map(r => ({
        id: r.id.trim(),
        group: r.group,
        label: text(r.label),
        host: r.host.trim(),
        port: number(r.port),
        user: r.user.trim(),
        password: r.password || undefined,
        hasPassword: keepsPassword(r) || undefined,
      })),
      processes: rows.processes.map(r => ({
        id: r.id.trim(),
        server: r.server,
        label: text(r.label),
        match: r.match.trim(),
        logFiles: patternList(r.logFiles),
        iniFiles: patternList(r.iniFiles),
        startScript: text(r.startScript),
        autoRestart: r.autoRestart === 'true' || undefined,
        watchName: text(r.watchName),
        watchArgs: text(r.watchArgs),
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timing, rows, savedServers]);

  // 검사 에러("servers[2].host: ...")에서 문제 칸("servers.2.host")을 뽑아 빨간 테두리로 표시한다.
  const errors = validation.ok ? [] : validation.errors;
  const invalidFields = new Set(
    errors.map(error => {
      const match = error.match(/^(\w+)\[(\d+)\]\.(\w+)/);
      return match ? `${match[1]}.${match[2]}.${match[3]}` : error.split(':')[0];
    })
  );
  const inputClass = (field: string) =>
    `input config-editor-input${invalidFields.has(field) ? ' config-editor-input-invalid' : ''}`;
  // 그룹 편집에서 보이는 행: 그 그룹의 서버, 다른 그룹 서버에 속하지 않은 프로세스. (전체 편집에서는 모두)
  const otherGroupServerIds = new Set(groupMode ? rows.servers.filter(r => r.group !== scope).map(r => r.id.trim()) : []);
  const isVisible = (section: Section, row: Row) =>
    !groupMode || (section === 'servers' ? row.group === scope : section === 'processes' ? !otherGroupServerIds.has(row.server) : false);
  /** 전체 배열 위치 → 화면 행 번호 (보이지 않으면 null) */
  const rowNumber = (section: Section, index: number) =>
    rows[section][index] && isVisible(section, rows[section][index]) ? rows[section].slice(0, index + 1).filter(r => isVisible(section, r)).length : null;

  const selectOptions: Record<string, string[]> = {
    group: rows.groups.map(r => r.slug.trim()).filter(Boolean),
    server: rows.servers.filter(r => isVisible('servers', r)).map(r => r.id.trim()).filter(Boolean),
  };
  const groupName = rows.groups.find(g => g.slug === scope)?.name || scope;

  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const updateRow = (section: Section, key: string, field: string, value: string) =>
    setRows(prev => ({ ...prev, [section]: prev[section].map(row => (row.key === key ? { ...row, [field]: value } : row)) }));

  const moveRow = (section: Section, from: number, to: number) =>
    setRows(prev => {
      const next = [...prev[section]];
      [next[from], next[to]] = [next[to], next[from]];
      return { ...prev, [section]: next };
    });
  /** index 위(-1) · 아래(+1)에서 가장 가까운 보이는 행의 위치 (없으면 -1). 그룹 편집에서는 가려진 다른 그룹 행을 건너뛴다. */
  const neighbor = (section: Section, index: number, step: -1 | 1) => {
    for (let i = index + step; i >= 0 && i < rows[section].length; i += step) {
      if (isVisible(section, rows[section][i])) return i;
    }
    return -1;
  };

  const addRow = (section: Section) =>
    setRows(prev => {
      // 비어 있는 이름(group-3, server-3 ...)을 찾아 id 로 쓴다.
      const prefix = { groups: 'group', servers: 'server', processes: 'process' }[section];
      const idField = section === 'groups' ? 'slug' : 'id';
      const used = new Set(prev[section].map(row => row[idField]));
      let n = prev[section].length + 1;
      while (used.has(`${prefix}-${n}`)) n++;

      const empty: Record<Section, Record<string, string>> = {
        groups: { slug: `${prefix}-${n}`, name: '' },
        servers: { id: `${prefix}-${n}`, group: groupMode ? scope : prev.groups[0]?.slug ?? '', label: '', host: '', port: '', user: '', password: '' },
        processes: {
          id: `${prefix}-${n}`,
          server: prev.servers.find(r => !groupMode || r.group === scope)?.id ?? '',
          label: '',
          match: '',
          logFiles: '',
          iniFiles: '',
          startScript: '',
          autoRestart: '',
          watchName: '',
          watchArgs: '',
        },
      };
      return { ...prev, [section]: [...prev[section], { key: String(nextRowKey++), ...empty[section] }] };
    });

  /** JSON 파일을 편집 화면으로 불러온다. 저장을 눌러야 반영된다. */
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    e.target.value = ''; // 같은 파일을 다시 골라도 change 가 발생하도록
    if (!selected) return;

    // 내보내기 파일에는 비밀번호가 없으므로, 비밀번호 누락은 막지 않고 불러온 뒤 표에서 빨간 칸으로 보여준다.
    let imported: unknown;
    let blocking: string[];
    try {
      imported = JSON.parse(await selected.text());
      const result = validateProcessConfig(imported);
      blocking = result.ok ? [] : result.errors.filter(error => !error.includes('.password:'));
    } catch (err) {
      blocking = [`JSON 형식이 아닙니다: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (blocking.length > 0) {
      setMessage({ kind: 'error', text: `가져오지 못했습니다 (${selected.name}):\n${blocking.map(error => toRowMessage(error)).join('\n')}` });
      return;
    }
    const next = imported as ProcessConfig;
    setTiming(toTiming(next));
    setRows(toRows(next));
    setMessage({ kind: 'info', text: `${selected.name} 을(를) 불러왔습니다. 저장을 눌러야 반영됩니다.` });
  };

  /** 편집 중인 내용을 processes.json 으로 내려받는다. 비밀번호는 넣지 않는다. */
  const handleExport = () => {
    if (!validation.ok) return;
    const exported = {
      ...validation.config,
      servers: validation.config.servers.map(({ password, hasPassword, ...server }) => server),
    };
    const blob = new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'processes.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleSave = async () => {
    if (!validation.ok) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave({ ...validation.config, version: baseVersion });
      onClose();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const conflict = text.includes('설정이 바뀌었습니다')
        ? '\n지금 편집한 내용은 저장되지 않았습니다. 남기려면 [내보내기]로 받아 둔 뒤, 창을 닫고 다시 열어(최신 설정을 읽습니다) 다시 고치세요.'
        : '';
      setMessage({ kind: 'error', text: `저장하지 못했습니다: ${text}${conflict}` });
      setSaving(false);
    }
  };

  return (
    <div className="config-editor-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="config-editor" role="dialog" aria-modal="true" aria-label="설정 편집">
        <header className="config-editor-header">
          <h2 className="config-editor-title">설정 편집{groupMode && ` — ${groupName}`}</h2>
          <div className="config-editor-header-actions">
            {/* 가져오기 · 내보내기는 설정 전체를 다루므로 전체(/all) 편집에서만 */}
            {!groupMode && (
              <>
                <input ref={importInputRef} type="file" accept=".json,application/json" hidden onChange={handleImport} />
                <button className="btn btn-secondary" onClick={() => importInputRef.current?.click()}>
                  가져오기
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleExport}
                  disabled={!validation.ok}
                  title="편집 중인 내용을 processes.json 으로 내려받습니다 (비밀번호 제외)"
                >
                  내보내기
                </button>
              </>
            )}
            <button className="btn-icon" onClick={onClose} title="닫기 (Esc)">
              ✕
            </button>
          </div>
        </header>

        <div className="config-editor-body">
          {groupMode && (
            <p className="config-editor-scope">
              {groupName} 그룹의 서버 · 프로세스만 편집합니다. 그룹 · 확인 주기 · 가져오기/내보내기는 전체 화면(/all)의 설정에서 바꿉니다.
            </p>
          )}
          {!groupMode && (
            <div className="config-editor-defaults">
              {TIMING_FIELDS.map(({ field, title, fallback, help }) => (
                <label key={field} className="config-editor-default" title={`${help} (비우면 ${fallback})`}>
                  {title}
                  <input
                    className={inputClass(field)}
                    type="number"
                    min={1000}
                    step={1000}
                    placeholder={String(fallback)}
                    value={timing[field]}
                    onChange={e => setTiming(prev => ({ ...prev, [field]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          )}

          {SECTIONS.filter(({ section }) => !groupMode || section !== 'groups').map(({ section, title, description, columns: allColumns }) => {
            // 그룹 편집에서는 서버의 그룹을 바꿀 수 없다. (새 서버는 이 그룹으로 만든다)
            const columns = groupMode ? allColumns.filter(column => column.field !== 'group') : allColumns;
            return (
              <section key={section} className="config-editor-section">
                <h3 className="config-editor-section-title">{title}</h3>
                <p className="config-editor-section-description">{description}</p>

                <table className="config-editor-table">
                  <thead>
                    <tr>
                      <th className="config-editor-col-order">순서</th>
                      {columns.map(column => (
                        <th key={column.field} className={column.className}>
                          {column.title}
                        </th>
                      ))}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows[section].map((row, i) => {
                      if (!isVisible(section, row)) return null;
                      const above = neighbor(section, i, -1);
                      const below = neighbor(section, i, 1);
                      return (
                        <tr key={row.key}>
                          <td className="config-editor-col-order">
                            <button className="btn-icon" onClick={() => moveRow(section, i, above)} disabled={above < 0} title="위로">
                              ▲
                            </button>
                            <button className="btn-icon" onClick={() => moveRow(section, i, below)} disabled={below < 0} title="아래로">
                              ▼
                            </button>
                          </td>
                          {columns.map(({ field, type, placeholder, className }) => {
                            const fieldClass = inputClass(`${section}.${i}.${field}`);
                            const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
                              updateRow(section, row.key, field, e.target.value);
                            return (
                              <td key={field} className={className}>
                                {type === 'select' ? (
                                  <select className={fieldClass} value={row[field]} onChange={onChange}>
                                    {!selectOptions[field].includes(row[field]) && <option value={row[field]}>{row[field] || '선택'}</option>}
                                    {selectOptions[field].map(option => (
                                      <option key={option} value={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    className={fieldClass}
                                    type={type ?? 'text'}
                                    autoComplete={type === 'password' ? 'new-password' : 'off'}
                                    placeholder={
                                      type === 'password' ? (keepsPassword(row) ? '저장됨 (바꿀 때만 입력)' : '입력 필요')
                                      : field === 'label' ? row.id
                                      : placeholder
                                    }
                                    value={row[field]}
                                    onChange={onChange}
                                  />
                                )}
                              </td>
                        );
                      })}
                      <td>
                        <button
                          className="btn-icon config-editor-remove"
                          onClick={() => setRows(prev => ({ ...prev, [section]: prev[section].filter(r => r.key !== row.key) }))}
                          title="삭제"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>

              <button className="btn btn-secondary config-editor-add" onClick={() => addRow(section)}>
                + {title} 추가
              </button>
            </section>
            );
          })}
        </div>

        <footer className="config-editor-footer">
          <div className="config-editor-messages">
            {errors.length > 0 && (
              <ul className="config-editor-errors">
                {errors.map(error => (
                  <li key={error}>{toRowMessage(error, rowNumber)}</li>
                ))}
              </ul>
            )}
            {message && <div className={`config-editor-message config-editor-message-${message.kind}`}>{message.text}</div>}
          </div>
          <div className="config-editor-footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              취소
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!validation.ok || saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default ConfigEditor;
