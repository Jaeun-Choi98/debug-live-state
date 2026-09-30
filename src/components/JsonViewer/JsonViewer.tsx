import React, { useState } from 'react';
import './JsonViewer.css';

type JsonNodeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined';

function getNodeType(value: unknown): JsonNodeType {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value as JsonNodeType;
}

function isExpandableType(type: JsonNodeType): boolean {
  return type === 'object' || type === 'array';
}

function entriesOf(value: unknown, type: JsonNodeType): Array<[string, unknown]> {
  if (type === 'array') {
    return (value as unknown[]).map((v, i) => [String(i), v]);
  }
  return Object.entries(value as Record<string, unknown>);
}

/** 이 노드 또는 하위 트리 어딘가에 filter와 일치하는 key/value가 있는지 검사한다. */
export function subtreeMatches(nodeKey: string | undefined, value: unknown, filter: string): boolean {
  if (!filter) return true;
  const lower = filter.toLowerCase();

  if (nodeKey && nodeKey.toLowerCase().includes(lower)) return true;

  const type = getNodeType(value);
  if (!isExpandableType(type)) {
    return String(value).toLowerCase().includes(lower);
  }

  return entriesOf(value, type).some(([k, v]) => subtreeMatches(k, v, filter));
}

const Highlight: React.FC<{ text: string; filter: string }> = ({ text, filter }) => {
  if (!filter) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerFilter = filter.toLowerCase();
  const index = lowerText.indexOf(lowerFilter);
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
  const type = getNodeType(value);
  const expandable = isExpandableType(type);
  const [manuallyExpanded, setManuallyExpanded] = useState<boolean | null>(null);

  if (filter && !subtreeMatches(nodeKey, value, filter)) {
    return null;
  }

  if (!expandable) {
    return (
      <div className="json-row">
        {nodeKey !== undefined && (
          <span className="json-key">
            <Highlight text={nodeKey} filter={filter} />
            {': '}
          </span>
        )}
        <span className={`json-value json-${type}`}>
          {type === 'string' ? (
            <>
              "<Highlight text={String(value)} filter={filter} />"
            </>
          ) : (
            <Highlight text={String(value)} filter={filter} />
          )}
        </span>
      </div>
    );
  }

  const entries = entriesOf(value, type);
  const [openBracket, closeBracket] = type === 'array' ? ['[', ']'] : ['{', '}'];

  const forceExpanded = filter !== '' && subtreeMatches(nodeKey, value, filter);
  const expanded = manuallyExpanded !== null ? manuallyExpanded : forceExpanded || depth < defaultExpandDepth;

  return (
    <div className="json-row">
      <span className="json-toggle" onClick={() => setManuallyExpanded(!expanded)}>
        <span className="json-caret">{expanded ? '▾' : '▸'}</span>
        {nodeKey !== undefined && (
          <span className="json-key">
            <Highlight text={nodeKey} filter={filter} />
            {': '}
          </span>
        )}
        <span className="json-bracket">{openBracket}</span>
        {!expanded && (
          <span className="json-summary">
            {entries.length} {type === 'array' ? 'items' : 'keys'}
          </span>
        )}
        {!expanded && <span className="json-bracket">{closeBracket}</span>}
      </span>
      {expanded && (
        <div className="json-children">
          {entries.length === 0 && <div className="json-empty">(empty)</div>}
          {entries.map(([k, v]) => (
            <JsonNode
              key={k}
              nodeKey={k}
              value={v}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
              filter={filter}
            />
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
