import { useEffect, useMemo } from 'react';

import type { Lang } from '../../../src/config/schema.js';
import { selectLang } from '../../../src/messages/index.js';
import {
  neededText,
  noteText,
  reasonText,
  verdictText,
  warningText,
  type Quote,
} from '../../../src/report/code-text.js';
import type {
  CellNote,
  Comparison,
  GateReason,
  Needed,
  Verdict,
} from '../../../src/report/schema.js';
import { useHashParam } from '../hooks/useHashParam.js';
import en from './en.json';
import ko from './ko.json';

// plan D8: the page's own strings live here; the codes of a comparison take the text of the
// message files of feature 001, so the command line and the page say the same.

export type PageMessageKey = keyof typeof en;
export type PageMessageParams = Readonly<Record<string, string | number>>;

const CATALOGS: Readonly<Record<Lang, Readonly<Record<PageMessageKey, string>>>> = { en, ko };
const PLACEHOLDER = /\{(\w+)\}/g;

/** React renders every string as a text node, so text from the model needs no quoting. */
const unchanged: Quote = (text) => text;

type Warning = Comparison['warnings'][number];

export interface Messages {
  readonly lang: Lang;
  text(key: PageMessageKey, params?: PageMessageParams): string;
  verdict(verdict: Verdict): string;
  note(note: CellNote): string;
  /** `currentTrials` is the cell's `candidate.trials`. */
  needed(needed: Needed, currentTrials: number): string;
  warning(warning: Warning): string;
  reason(reason: GateReason): string;
}

/** A placeholder without a value stays as written, so a missing parameter shows in the page. */
function fill(template: string, params: PageMessageParams): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** The messages of one language, for a component that is given the page language. */
export function pageMessages(lang: Lang): Messages {
  return {
    lang,
    text: (key, params = {}) => fill(CATALOGS[lang][key], params),
    verdict: (verdict) => verdictText(lang, verdict),
    note: (note) => noteText(lang, note),
    needed: (needed, currentTrials) => neededText(lang, needed, currentTrials),
    warning: (warning) => warningText(lang, warning, unchanged),
    reason: (reason) => reasonText(lang, reason, unchanged),
  };
}

/** The page language is `?lang=` of the hash first, then the payload's `lang`. */
export function useMessages(payloadLang: Lang): Messages {
  const [hash] = useHashParam();
  const lang = selectLang(hash.lang ?? undefined, payloadLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return useMemo(() => pageMessages(lang), [lang]);
}
