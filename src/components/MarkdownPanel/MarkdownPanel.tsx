import React, { useEffect, useState } from 'react';
import './MarkdownPanel.css';

interface MarkdownPanelProps {
  /** public/config 아래의 md 파일 이름 (예: README.md). 파일이 없으면 패널을 그리지 않는다. */
  file: string;
  title: string;
  /** 처음 들어왔을 때 펼쳐 둘지. 이후에는 사용자가 접고 편 상태를 브라우저에 기억한다. */
  defaultOpen: boolean;
}

/**
 * README 에 흔히 쓰는 마크다운만 HTML 로 바꾼다.
 * 지원: 제목(#~####), 목록(- / 1.), 코드 블록(```), 인용(>), 표(|), 구분선(---), 문단,
 *       줄 안의 `코드`, **굵게**, [링크](https://...)
 * 원문은 먼저 이스케이프하므로 README 에 HTML 을 써도 그대로 글자로 보인다.
 */
function renderMarkdown(markdown: string): string {
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (text: string) =>
    escape(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // http(s) · 사이트 내부 경로만 링크로 만든다. (javascript: 등은 글자로 남는다)
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|#)[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  // pattern 에 맞는 줄이 이어지는 동안 모은다.
  const collect = (pattern: RegExp) => {
    const block: string[] = [];
    while (i < lines.length && pattern.test(lines[i])) block.push(lines[i++]);
    return block;
  };

  while (i < lines.length) {
    const line = lines[i];
    const heading = line.match(/^(#{1,4})\s+(.*)$/);

    if (line.trim() === '') {
      i++;
    } else if (line.startsWith('```')) {
      i++;
      const code = collect(/^(?!```)/);
      i++; // 닫는 ```
      html.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
    } else if (heading) {
      i++;
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      i++;
      html.push('<hr>');
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items = collect(/^\s*[-*]\s+/).map(item => `<li>${inline(item.replace(/^\s*[-*]\s+/, ''))}</li>`);
      html.push(`<ul>${items.join('')}</ul>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const items = collect(/^\s*\d+\.\s+/).map(item => `<li>${inline(item.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      html.push(`<ol>${items.join('')}</ol>`);
    } else if (line.startsWith('>')) {
      const quote = collect(/^>/).map(q => inline(q.replace(/^>\s?/, '')));
      html.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
    } else if (line.startsWith('|')) {
      // 첫 줄은 제목 행, |---|---| 구분 행은 건너뛴다.
      const rows = collect(/^\|/)
        .filter(row => !/^\|[\s:|-]+$/.test(row.trim()))
        .map(row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim())));
      const [head = [], ...body] = rows;
      html.push(
        `<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
    } else {
      // 문단: 다른 블록이 시작되거나 빈 줄이 나올 때까지 이어 붙인다.
      const paragraph = [lines[i++], ...collect(/^(?!\s*$|#{1,4}\s|```|>|\||\s*[-*]\s+|\s*\d+\.\s+)/)];
      html.push(`<p>${paragraph.map(inline).join(' ')}</p>`);
    }
  }
  return html.join('\n');
}

/** config 폴더의 md 파일(소개, API 명세 등)을 대시보드 위에 접고 펼 수 있는 패널로 보여준다. */
const MarkdownPanel: React.FC<MarkdownPanelProps> = ({ file, title, defaultOpen }) => {
  const url = `${process.env.PUBLIC_URL}/config/${file}`;
  const openStorageKey = `process-management.panel-open.${file}`;
  const [html, setHtml] = useState<string | null>(null);
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(openStorageKey);
      return saved === null ? defaultOpen : saved === 'true';
    } catch {
      return defaultOpen;
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        // 파일이 없으면 Go 서버는 404 를, 개발 서버는 index.html 을 돌려준다. 이때는 패널을 그리지 않는다.
        const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
        if (response.ok && !isHtml) setHtml(renderMarkdown(await response.text()));
      })
      .catch(() => {
        // 안내문이 없어도 대시보드는 그대로 동작해야 하므로 무시한다.
      });
    return () => controller.abort();
  }, [url]);

  if (html === null) return null;

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(openStorageKey, String(!open));
    } catch {
      // 저장소를 못 쓰면(시크릿 창 등) 이번 방문 동안만 기억한다.
    }
  };

  return (
    <section className="markdown-panel">
      <button type="button" className="markdown-panel-toggle" onClick={toggle} aria-expanded={open}>
        <span>{title}</span>
        <span className="markdown-panel-caret">{open ? '접기 ▴' : '펼치기 ▾'}</span>
      </button>
      {open && <div className="markdown-panel-body" dangerouslySetInnerHTML={{ __html: html }} />}
    </section>
  );
};

export default MarkdownPanel;
