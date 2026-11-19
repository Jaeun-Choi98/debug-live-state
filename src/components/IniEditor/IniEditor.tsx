import React, { useCallback, useEffect, useState } from 'react';
import { IniFile } from '../../config/types';
import { requestApi } from '../../hooks/useProcessConfig';
import './IniEditor.css';

interface IniEditorProps {
  processId: string;
  /** 설정 폴더 기준 상대 경로 (*.ini) */
  path: string;
  /** 저장하지 않은 변경이 생기거나 없어질 때 알린다. (창을 닫을 때 확인용) */
  onDirtyChange: (dirty: boolean) => void;
}

const PROCESSES_API = `${process.env.PUBLIC_URL}/api/processes`;

/**
 * 설정 폴더 아래 *.ini 파일 하나를 통째로 읽어 고치고 저장한다.
 *
 * - 저장할 때 읽었던 내용의 hash 를 같이 보내, 그 사이 다른 곳에서 파일이 바뀌었으면 서버가 거부한다(409).
 * - 브라우저 입력칸은 줄바꿈을 \n 으로 바꾸므로, 원래 파일이 CRLF(\r\n)였으면 저장할 때 되돌린다.
 * - 서버는 바꾸기 전 내용을 '<파일>.bak' 에 남긴다.
 */
const IniEditor: React.FC<IniEditorProps> = ({ processId, path, onDirtyChange }) => {
  /** 서버에 있는 내용 (줄바꿈은 \n 으로 바꾼 것) */
  const [saved, setSaved] = useState<{ text: string; hash: string; crlf: boolean } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const url = `${PROCESSES_API}/${encodeURIComponent(processId)}/ini?path=${encodeURIComponent(path)}`;
  const dirty = saved !== null && text !== saved.text;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const accept = (file: IniFile) => {
    const crlf = file.content.includes('\r\n');
    const normalized = file.content.replace(/\r\n/g, '\n');
    setSaved({ text: normalized, hash: file.hash, crlf });
    setText(normalized);
  };

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      accept(await requestApi<IniFile>(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [url]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!saved || !dirty || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const content = saved.crlf ? text.replace(/\n/g, '\r\n') : text;
      accept(
        await requestApi<IniFile>(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, baseHash: saved.hash }),
        })
      );
      setMessage(`저장했습니다 (${new Date().toLocaleTimeString()}). 이전 내용은 ${path.split('/').pop()}.bak 에 있습니다.`);
    } catch (e) {
      setError(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    if (dirty && !window.confirm('고친 내용을 버리고 파일을 다시 읽을까요?')) return;
    load();
  };

  return (
    <div className="ini-editor">
      <div className="ini-editor-toolbar">
        <button className="btn btn-primary" onClick={save} disabled={!dirty || busy} title="저장 (Ctrl/⌘ + S)">
          {busy && saved ? '저장 중...' : '저장'}
        </button>
        <button className="btn btn-secondary" onClick={() => saved && setText(saved.text)} disabled={!dirty || busy}>
          되돌리기
        </button>
        <button className="btn btn-secondary" onClick={reload} disabled={busy}>
          ↻ 다시 읽기
        </button>
        <span className="ini-editor-info">
          {dirty && <strong className="ini-editor-dirty">● 저장 안 됨</strong>}
          {saved && `UTF-8 · ${saved.crlf ? 'CRLF' : 'LF'} · ${text.split('\n').length}줄`}
        </span>
      </div>

      {error && <div className="log-viewer-error">{error}</div>}
      {message && <div className="ini-editor-message">{message}</div>}

      {saved === null ? (
        <div className="log-viewer-placeholder">{busy ? '읽는 중...' : ''}</div>
      ) : (
        <textarea
          className="ini-editor-text"
          value={text}
          spellCheck={false}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              save();
            }
          }}
        />
      )}
    </div>
  );
};

export default IniEditor;
