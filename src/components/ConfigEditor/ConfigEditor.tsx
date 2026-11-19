import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_POLL_INTERVAL_MS, ValidationResult, validateEndpointsFile } from '../../config/schema';
import { EndpointEntry, EndpointsFile } from '../../config/types';
import './ConfigEditor.css';

interface ConfigEditorProps {
  file: EndpointsFile;
  /** false 면 설정 API 가 없어 저장할 수 없다. (내보내기만 가능) */
  editable: boolean;
  /** 실패하면 에러를 던진다. */
  onSave: (file: EndpointsFile) => Promise<void>;
  onClose: () => void;
}

/**
 * 편집 중인 한 행. 입력칸 값을 문자열 그대로 들고 있다가 검사·저장할 때 변환한다.
 * key 는 React 용이다. (id 는 편집되므로 key 로 쓸 수 없다)
 */
type Row = Record<keyof EndpointEntry, string> & { key: number };

let nextRowKey = 0;

const toRows = (file: EndpointsFile): Row[] =>
  file.endpoints.map(e => ({
    key: nextRowKey++,
    id: e.id,
    group: e.group ?? '',
    label: e.label ?? '',
    url: e.url,
    pollIntervalMs: e.pollIntervalMs?.toString() ?? '',
  }));

/** "endpoints[2].url: ..." → "3번째 행 url: ..." */
const toRowMessage = (message: string) =>
  message.replace(/^endpoints\[(\d+)\]\.?/, (_, i: string) => `${Number(i) + 1}번째 행 `);

/** ⚙ 설정: 엔드포인트를 추가·삭제·수정·정렬하고, JSON 파일로 가져오거나 내보내고, 서버에 저장한다. */
const ConfigEditor: React.FC<ConfigEditorProps> = ({ file, editable, onSave, onClose }) => {
  const [defaultInterval, setDefaultInterval] = useState(file.pollIntervalMs?.toString() ?? '');
  const [rows, setRows] = useState<Row[]>(() => toRows(file));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 입력칸 값을 설정 파일 형태로 바꿔 검사한다.
  // 빈 칸은 생략(기본값 사용)하고, 숫자가 아닌 값은 NaN 으로 두어 검사에 걸리게 한다.
  const validation = useMemo(() => {
    const text = (value: string) => value.trim() || undefined;
    const number = (value: string) => (value.trim() === '' ? undefined : Number(value));
    return validateEndpointsFile({
      pollIntervalMs: number(defaultInterval),
      endpoints: rows.map(row => ({
        id: row.id.trim(),
        group: text(row.group),
        label: text(row.label),
        url: row.url.trim(),
        pollIntervalMs: number(row.pollIntervalMs),
      })),
    });
  }, [defaultInterval, rows]);

  // 검사 에러("endpoints[2].url: ...")에서 문제 칸("2.url")을 뽑아 빨간 테두리로 표시한다.
  const errors = validation.ok ? [] : validation.errors;
  const invalidFields = new Set(
    errors.map(error => {
      const match = error.match(/^endpoints\[(\d+)\]\.(\w+)/);
      return match ? `${match[1]}.${match[2]}` : error.split(':')[0];
    })
  );
  const inputClass = (field: string) =>
    `input config-editor-input${invalidFields.has(field) ? ' config-editor-input-invalid' : ''}`;
  const groupNames = Array.from(new Set(rows.map(row => row.group.trim()).filter(Boolean)));

  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const updateRow = (key: number, field: keyof EndpointEntry, value: string) =>
    setRows(prev => prev.map(row => (row.key === key ? { ...row, [field]: value } : row)));

  const moveRow = (from: number, to: number) =>
    setRows(prev => {
      const next = [...prev];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });

  const addRow = () =>
    setRows(prev => {
      const ids = new Set(prev.map(row => row.id));
      let n = prev.length + 1;
      while (ids.has(`endpoint-${n}`)) n++;
      return [...prev, { key: nextRowKey++, id: `endpoint-${n}`, group: '', label: '', url: '', pollIntervalMs: '' }];
    });

  /** JSON 파일을 편집 화면으로 불러온다. 저장을 눌러야 반영된다. */
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    e.target.value = ''; // 같은 파일을 다시 골라도 change 가 발생하도록
    if (!selected) return;

    let result: ValidationResult;
    try {
      result = validateEndpointsFile(JSON.parse(await selected.text()));
    } catch (err) {
      result = { ok: false, errors: [`JSON 형식이 아닙니다: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!result.ok) {
      setMessage({ kind: 'error', text: `가져오지 못했습니다 (${selected.name}):\n${result.errors.map(toRowMessage).join('\n')}` });
      return;
    }
    setDefaultInterval(result.file.pollIntervalMs?.toString() ?? '');
    setRows(toRows(result.file));
    setMessage({ kind: 'info', text: `${selected.name} 을(를) 불러왔습니다. 저장을 눌러야 반영됩니다.` });
  };

  /** 편집 중인 내용을 endpoints.json 으로 내려받는다. */
  const handleExport = () => {
    if (!validation.ok) return;
    const blob = new Blob([JSON.stringify(validation.file, null, 2) + '\n'], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'endpoints.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleSave = async () => {
    if (!validation.ok) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave(validation.file);
      onClose();
    } catch (err) {
      setMessage({ kind: 'error', text: `저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
      setSaving(false);
    }
  };

  return (
    <div className="config-editor-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="config-editor" role="dialog" aria-modal="true" aria-label="설정 편집">
        <header className="config-editor-header">
          <h2 className="config-editor-title">설정 편집</h2>
          <div className="config-editor-header-actions">
            <input ref={importInputRef} type="file" accept=".json,application/json" hidden onChange={handleImport} />
            <button className="btn btn-secondary" onClick={() => importInputRef.current?.click()}>
              가져오기
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleExport}
              disabled={!validation.ok}
              title="편집 중인 내용을 endpoints.json 으로 내려받습니다"
            >
              내보내기
            </button>
            <button className="btn-icon" onClick={onClose} title="닫기 (Esc)">
              ✕
            </button>
          </div>
        </header>

        {!editable && (
          <div className="config-editor-notice">
            설정 API(<code>/api/config</code>)가 없는 환경이라 저장할 수 없습니다. 내보내기로 받은 파일로{' '}
            <code>public/config/endpoints.json</code> 을 교체하세요.
          </div>
        )}

        <div className="config-editor-body">
          <label className="config-editor-default">
            기본 폴링 주기(ms)
            <input
              className={inputClass('pollIntervalMs')}
              type="number"
              min={1}
              placeholder={String(DEFAULT_POLL_INTERVAL_MS)}
              value={defaultInterval}
              onChange={e => setDefaultInterval(e.target.value)}
            />
          </label>

          <datalist id="config-editor-groups">
            {groupNames.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <table className="config-editor-table">
            <thead>
              <tr>
                <th className="config-editor-col-order">순서</th>
                <th>id *</th>
                <th>그룹</th>
                <th>표시 이름</th>
                <th className="config-editor-col-url">URL *</th>
                <th className="config-editor-col-interval">주기(ms)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.key}>
                  <td className="config-editor-col-order">
                    <button className="btn-icon" onClick={() => moveRow(i, i - 1)} disabled={i === 0} title="위로">
                      ▲
                    </button>
                    <button className="btn-icon" onClick={() => moveRow(i, i + 1)} disabled={i === rows.length - 1} title="아래로">
                      ▼
                    </button>
                  </td>
                  <td>
                    <input className={inputClass(`${i}.id`)} value={row.id} onChange={e => updateRow(row.key, 'id', e.target.value)} />
                  </td>
                  <td>
                    <input
                      className={inputClass(`${i}.group`)}
                      list="config-editor-groups"
                      placeholder="미분류"
                      value={row.group}
                      onChange={e => updateRow(row.key, 'group', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className={inputClass(`${i}.label`)}
                      placeholder={row.id}
                      value={row.label}
                      onChange={e => updateRow(row.key, 'label', e.target.value)}
                    />
                  </td>
                  <td className="config-editor-col-url">
                    <input
                      className={inputClass(`${i}.url`)}
                      placeholder="http://host:port/path"
                      value={row.url}
                      onChange={e => updateRow(row.key, 'url', e.target.value)}
                    />
                  </td>
                  <td className="config-editor-col-interval">
                    <input
                      className={inputClass(`${i}.pollIntervalMs`)}
                      type="number"
                      min={1}
                      placeholder="기본값"
                      value={row.pollIntervalMs}
                      onChange={e => updateRow(row.key, 'pollIntervalMs', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      className="btn-icon config-editor-remove"
                      onClick={() => setRows(prev => prev.filter(r => r.key !== row.key))}
                      title="삭제"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button className="btn btn-secondary config-editor-add" onClick={addRow}>
            + 엔드포인트 추가
          </button>
        </div>

        <footer className="config-editor-footer">
          <div className="config-editor-messages">
            {errors.length > 0 && (
              <ul className="config-editor-errors">
                {errors.map(error => (
                  <li key={error}>{toRowMessage(error)}</li>
                ))}
              </ul>
            )}
            {message && <div className={`config-editor-message config-editor-message-${message.kind}`}>{message.text}</div>}
          </div>
          <div className="config-editor-footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              취소
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!editable || !validation.ok || saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default ConfigEditor;
