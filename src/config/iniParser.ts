export type IniSection = Record<string, string>;
export type IniDocument = Record<string, IniSection>;

/**
 * 최소 기능 INI 파서. 섹션 중첩, 배열 값 등은 지원하지 않는다.
 * `[section]` 헤더와 `key=value` 라인, `;` / `#` 주석만 처리한다.
 */
export function parseIni(text: string): IniDocument {
  const doc: IniDocument = {};
  let currentSection: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!doc[currentSection]) {
        doc[currentSection] = {};
      }
      continue;
    }

    if (currentSection === null) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === '') {
      continue;
    }

    doc[currentSection][key] = value;
  }

  return doc;
}
