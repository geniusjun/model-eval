/**
 * A reader of the CommonMark code constructs the report relies on, written independently of
 * the report writer: fenced code blocks (backtick fences only) and code spans.
 */

export interface CodeSegment {
  readonly fence: string;
  readonly content: string;
  readonly block: boolean;
}

export interface ScannedMarkdown {
  /** Every code block and code span, in document order. */
  readonly code: readonly CodeSegment[];
  /** Lines outside code blocks, with their code spans removed. */
  readonly prose: readonly string[];
  /** Level-2 headings outside code blocks, with the lines under each up to the next one. */
  readonly sections: ReadonlyMap<string, string>;
}

const OPENING_FENCE = /^ {0,3}(`{3,})[^`]*$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}) *$/;

export function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
}

function scanLine(line: string, code: CodeSegment[]): string {
  const runs = [...line.matchAll(/`+/g)];
  let prose = '';
  let position = 0;
  let index = 0;
  while (index < runs.length) {
    const opener = runs[index];
    const closerIndex = runs.findIndex(
      (run, at) => at > index && run[0].length === opener?.[0].length,
    );
    const closer = runs[closerIndex];
    if (opener === undefined || closer === undefined) {
      index += 1;
      continue;
    }
    let content = line.slice(opener.index + opener[0].length, closer.index);
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    code.push({ fence: opener[0], content, block: false });
    prose += line.slice(position, opener.index);
    position = closer.index + closer[0].length;
    index = closerIndex + 1;
  }
  return prose + line.slice(position);
}

export function scanMarkdown(markdown: string): ScannedMarkdown {
  const lines = markdown.split('\n');
  const code: CodeSegment[] = [];
  const prose: string[] = [];
  const sections = new Map<string, string[]>();
  let section: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    const opening = OPENING_FENCE.exec(line)?.[1];
    if (opening !== undefined) {
      const body: string[] = [];
      let end = at + 1;
      for (; end < lines.length; end += 1) {
        const closing = CLOSING_FENCE.exec(lines[end] ?? '')?.[1];
        if (closing !== undefined && closing.length >= opening.length) {
          break;
        }
        body.push(lines[end] ?? '');
      }
      code.push({ fence: opening, content: body.join('\n'), block: true });
      section.push(...lines.slice(at, end + 1));
      at = end;
      continue;
    }
    if (line.startsWith('## ')) {
      section = [];
      sections.set(line.slice(3), section);
    } else {
      section.push(line);
    }
    prose.push(scanLine(line, code));
  }
  return {
    code,
    prose,
    sections: new Map([...sections].map(([heading, body]) => [heading, body.join('\n')])),
  };
}
