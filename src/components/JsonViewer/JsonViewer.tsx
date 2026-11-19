import React, { useState } from 'react';
import './JsonViewer.css';

/** 이 노드 또는 하위 어딘가에 filter 와 일치하는 key/value 가 있는지 검사한다. (대소문자 무시) */
export function subtreeMatches(nodeKey: string | undefined, value: unknown, filter: string): boolean {
  if (!filter) return true;
  const lower = filter.toLowerCase();
  if (nodeKey?.toLowerCase().includes(lower)) return true;

  if (typeof value !== 'object' || value === null) {
    return String(value).toLowerCase().includes(lower);
  }
  return Object.entries(value).some(([k, v]) => subtreeMatches(k, v, filter));
}

/** text 에서 filter 와 처음 일치하는 부분을 강조한다. */
const Highlight: React.FC<{ text: string; filter: string }> = ({ text, filter }) => {
  const index = filter ? text.toLowerCase().indexOf(filter.toLowerCase()) : -1;
  if (index === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, index)}
      <mark className="json-highlight">{text.slice(index, index + filter.length)}</mark>
      {text.slice(index + filter.length)}
    </>
  );
};

interface JsonNodeProps {
  value: unknown;
  nodeKey?: string;
  depth: number;
  defaultExpandDepth: number;
  filter: string;
}

const JsonNode: React.FC<JsonNodeProps> = ({ value, nodeKey, depth, defaultExpandDepth, filter }) => {
  // 사용자가 직접 펼치거나 접기 전(null)에는 깊이와 검색 결과에 따라 자동으로 펼친다.
  const [manuallyExpanded, setManuallyExpanded] = useState<boolean | null>(null);

  if (filter && !subtreeMatches(nodeKey, value, filter)) return null;

  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const keyLabel = nodeKey !== undefined && (
    <span className="json-key">
      <Highlight text={nodeKey} filter={filter} />
      {': '}
    </span>
  );

  // 값 (문자열 · 숫자 · boolean · null)
  if (typeof value !== 'object' || value === null) {
    const text = <Highlight text={String(value)} filter={filter} />;
    return (
      <div className="json-row">
        {keyLabel}
        <span className={`json-value json-${type}`}>{type === 'string' ? <>"{text}"</> : text}</span>
      </div>
    );
  }

  // 객체 · 배열
  const entries = Object.entries(value);
  const [openBracket, closeBracket] = type === 'array' ? ['[', ']'] : ['{', '}'];
  const expanded = manuallyExpanded ?? (filter !== '' || depth < defaultExpandDepth);

  return (
    <div className="json-row">
      <span className="json-toggle" onClick={() => setManuallyExpanded(!expanded)}>
        <span className="json-caret">{expanded ? '▾' : '▸'}</span>
        {keyLabel}
        <span className="json-bracket">{openBracket}</span>
        {!expanded && (
          <>
            <span className="json-summary">
              {entries.length} {type === 'array' ? 'items' : 'keys'}
            </span>
            <span className="json-bracket">{closeBracket}</span>
          </>
        )}
      </span>
      {expanded && (
        <div className="json-children">
          {entries.length === 0 && <div className="json-empty">(empty)</div>}
          {entries.map(([k, v]) => (
            <JsonNode key={k} nodeKey={k} value={v} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} filter={filter} />
          ))}
          <div className="json-bracket">{closeBracket}</div>
        </div>
      )}
    </div>
  );
};

interface JsonViewerProps {
  data: unknown;
  filter?: string;
  defaultExpandDepth?: number;
}

/** 응답 JSON 전체를 접고 펼 수 있는 트리로 보여준다. filter 가 있으면 일치하는 부분만 남긴다. */
const JsonViewer: React.FC<JsonViewerProps> = ({ data, filter = '', defaultExpandDepth = 2 }) => {
  if (filter && !subtreeMatches(undefined, data, filter)) {
    return <div className="json-no-match">일치하는 항목이 없습니다.</div>;
  }
  return (
    <div className="json-viewer">
      <JsonNode value={data} depth={0} defaultExpandDepth={defaultExpandDepth} filter={filter} />
    </div>
  );
};

export default JsonViewer;
