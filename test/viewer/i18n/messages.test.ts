import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Lang } from '../../../src/config/schema.js';
import {
  neededText,
  noteText,
  reasonText,
  verdictText,
  warningText,
} from '../../../src/report/code-text.js';
import { verdictSchema } from '../../../src/report/schema.js';
import en from '../../../viewer/src/i18n/en.json';
import ko from '../../../viewer/src/i18n/ko.json';
import { useMessages } from '../../../viewer/src/i18n/useMessages.js';
import { COMPARISON_FIXTURES, loadComparison } from '../fixtures.js';

const LANGS: readonly Lang[] = ['en', 'ko'];
const unchanged = (text: string): string => text;

afterEach(() => {
  window.location.hash = '';
});

function messagesFor(payloadLang: Lang) {
  return renderHook(() => useMessages(payloadLang)).result.current;
}

describe('002 page messages', () => {
  it('002 FR-013 has the same keys in en.json and ko.json and no empty text', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of [...Object.entries(en), ...Object.entries(ko)]) {
      expect(text.trim(), key).not.toBe('');
    }
  });

  it('002 FR-013 starts in the payload language and sets <html lang>', () => {
    for (const lang of LANGS) {
      expect(messagesFor(lang).lang).toBe(lang);
      expect(document.documentElement.lang).toBe(lang);
    }
  });

  it('002 FR-013 takes ?lang= in the hash over the payload language', () => {
    window.location.hash = '#/?lang=ko';
    expect(messagesFor('en').lang).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
    window.location.hash = '#/cell/script-ja/ja/raw?lang=en';
    expect(messagesFor('ko').lang).toBe('en');
    window.location.hash = '#/?lang=fr';
    expect(messagesFor('ko').lang).toBe('ko');
  });

  it('002 FR-013 gives verdicts, notes, needed, warnings and gate reasons the text of code-text.ts', () => {
    for (const lang of LANGS) {
      const messages = messagesFor(lang);
      expect(messages.text('language.label')).toBe(
        lang === 'en' ? en['language.label'] : ko['language.label'],
      );
      for (const verdict of verdictSchema.options) {
        expect(messages.verdict(verdict)).toBe(verdictText(lang, verdict));
      }
      for (const kind of COMPARISON_FIXTURES) {
        const comparison = loadComparison(kind);
        for (const cell of comparison.cells) {
          if (cell.note !== undefined) {
            expect(messages.note(cell.note)).toBe(noteText(lang, cell.note));
          }
          if (cell.needed !== undefined) {
            expect(messages.needed(cell.needed, cell.candidate.trials)).toBe(
              neededText(lang, cell.needed, cell.candidate.trials),
            );
          }
        }
        for (const warning of comparison.warnings) {
          expect(messages.warning(warning)).toBe(warningText(lang, warning, unchanged));
        }
        for (const reason of comparison.gate.reasons) {
          expect(messages.reason(reason)).toBe(reasonText(lang, reason, unchanged));
        }
      }
    }
  });
});
