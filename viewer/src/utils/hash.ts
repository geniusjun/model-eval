import type { Lang } from '../../../src/config/schema.js';
import { isLang } from '../../../src/messages/index.js';
import type { Cell, Comparison } from '../../../src/report/schema.js';
import { ruleSampleKeys } from '../report/sampleKeys.js';

// page-data §Location Hash: the reader's place, so a link to one view can sit next to the file.

export interface CellView {
  readonly kind: 'cell';
  readonly ruleId: string;
  /** The language of the cell's cases, not the page language. */
  readonly lang: string;
  readonly surface: string;
}

export interface SideView {
  readonly kind: 'side';
  readonly ruleId: string;
  readonly caseId: string;
  readonly repeat: number;
}

export interface SummaryView {
  readonly kind: 'summary';
}

export type HashView = SummaryView | CellView | SideView;

export interface PageHash {
  readonly view: HashView;
  /** The page language `?lang=` names, or null when it names none or one the page lacks. */
  readonly lang: Lang | null;
}

export type ResolvedView = SummaryView | { readonly kind: 'cell'; readonly cell: Cell } | SideView;

const SUMMARY: SummaryView = { kind: 'summary' };
/** A repeat index as written by `formatHash`: no sign, no leading zero. */
const REPEAT = /^(0|[1-9]\d*)$/;

/** The decoded segments of `/a/b/c`, or null when a segment is not valid percent-encoding. */
function segments(path: string): string[] | null {
  try {
    return path.split('/').slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
}

function parseView(path: string): HashView {
  if (path === '' || path === '/') {
    return SUMMARY;
  }
  if (!path.startsWith('/')) {
    return SUMMARY;
  }
  const parts = segments(path);
  if (parts === null) {
    return SUMMARY;
  }
  const [kind, first, second, third, ...rest] = parts;
  if (first === undefined || second === undefined || third === undefined || rest.length > 0) {
    return SUMMARY;
  }
  if (kind === 'cell') {
    return { kind: 'cell', ruleId: first, lang: second, surface: third };
  }
  if (kind === 'side' && REPEAT.test(third)) {
    return { kind: 'side', ruleId: first, caseId: second, repeat: Number(third) };
  }
  return SUMMARY;
}

function parseLang(query: string): Lang | null {
  const lang = new URLSearchParams(query).get('lang');
  return lang !== null && isLang(lang) ? lang : null;
}

/** Reads `location.hash`; whatever it holds, the result is a view the page can show. */
export function parseHash(hash: string): PageHash {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryAt = body.indexOf('?');
  const path = queryAt === -1 ? body : body.slice(0, queryAt);
  const query = queryAt === -1 ? '' : body.slice(queryAt + 1);
  return { view: parseView(path), lang: parseLang(query) };
}

function viewPath(view: HashView): string {
  switch (view.kind) {
    case 'summary':
      return '/';
    case 'cell':
      return ['', 'cell', view.ruleId, view.lang, view.surface].map(encodeURIComponent).join('/');
    case 'side':
      return ['', 'side', view.ruleId, view.caseId, String(view.repeat)]
        .map(encodeURIComponent)
        .join('/');
  }
}

export function formatHash({ view, lang }: PageHash): string {
  return lang === null ? `#${viewPath(view)}` : `#${viewPath(view)}?lang=${lang}`;
}

function findCell(view: CellView, comparison: Comparison): Cell | undefined {
  return comparison.cells.find(
    (cell) =>
      cell.ruleId === view.ruleId && cell.lang === view.lang && cell.surface === view.surface,
  );
}

/** A side-by-side position exists when a `review` sample or a failing example of the rule has it. */
function hasSidePosition(view: SideView, comparison: Comparison): boolean {
  return ruleSampleKeys(comparison.samples, view.ruleId).some(
    (key) => key.caseId === view.caseId && key.repeat === view.repeat,
  );
}

/** The view a hash names in this comparison; a name it does not hold opens the summary. */
export function resolveView(view: HashView, comparison: Comparison): ResolvedView {
  switch (view.kind) {
    case 'summary':
      return SUMMARY;
    case 'cell': {
      const cell = findCell(view, comparison);
      return cell === undefined ? SUMMARY : { kind: 'cell', cell };
    }
    case 'side':
      return hasSidePosition(view, comparison) ? view : SUMMARY;
  }
}
