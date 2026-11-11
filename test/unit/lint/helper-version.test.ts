import { describe, expect, it } from 'vitest';

import { lintText, textOf } from '../../../src/cli/human/text.js';

import {
  BUNDLED_HELPER_VERSION,
  helperOutdated,
  isHelperOutdated,
} from '../../../src/lint/helper-version.js';
import { message } from '../../../src/messages/index.js';

const PLACE = { file: 'model-eval.config.yaml', line: 3, column: 12 };

describe('helper-outdated', () => {
  it('001 FR-035 bundles one helper version of the form MAJOR.MINOR.PATCH', () => {
    expect(BUNDLED_HELPER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('001 FR-035 reports an older helper, comparing each part as a number', () => {
    expect(isHelperOutdated('0.0.9', '0.1.0')).toBe(true);
    expect(isHelperOutdated('0.9.0', '1.0.0')).toBe(true);
    expect(isHelperOutdated('1.2.9', '1.2.10')).toBe(true);
    expect(isHelperOutdated('1.9.0', '1.10.0')).toBe(true);
  });

  it('001 FR-035 does not report an equal or newer helper', () => {
    expect(isHelperOutdated('0.1.0', '0.1.0')).toBe(false);
    expect(isHelperOutdated('1.2.10', '1.2.9')).toBe(false);
    expect(isHelperOutdated('2.0.0', '1.99.99')).toBe(false);
    expect(isHelperOutdated('0.1.0', '0.0.99')).toBe(false);
  });

  it('001 FR-035 reports a version that cannot be compared', () => {
    for (const version of ['0.1', '0.1.0.1', 'v0.1.0', '0.1.0-beta', '0.-1.0', 'dev', '']) {
      expect(isHelperOutdated(version, '0.1.0'), version).toBe(true);
    }
  });

  it('001 FR-035 gives one finding per reported version with the variants that reported it', () => {
    const findings = helperOutdated(
      [
        { variant: 'current', helper: { language: 'python', version: '0.0.9' } },
        { variant: 'next', helper: { language: 'python', version: '0.0.9' } },
        { variant: 'other', helper: { language: 'typescript', version: 'dev' } },
        { variant: 'newer', helper: { language: 'python', version: '0.2.0' } },
      ],
      PLACE,
      '0.1.0',
    );
    expect(findings).toEqual([
      {
        code: 'helper-outdated',
        params: { version: '0.0.9', bundled: '0.1.0' },
        variants: ['current', 'next'],
        ...PLACE,
      },
      {
        code: 'helper-outdated',
        params: { version: 'dev', bundled: '0.1.0' },
        variants: ['other'],
        ...PLACE,
      },
    ]);
  });

  it('001 FR-035 says a version that cannot be compared is not MAJOR.MINOR.PATCH, not that it is older', () => {
    for (const lang of ['en', 'ko'] as const) {
      const text = (version: string) =>
        lintText(textOf(lang), { code: 'helper-outdated', params: { version, bundled: '0.1.0' } });
      expect(text('dev')).toBe(
        message(lang, 'lint.helper-outdated.unknown', { version: 'dev', bundled: '0.1.0' }),
      );
      expect(text('0.0.9')).toBe(
        message(lang, 'lint.helper-outdated', { version: '0.0.9', bundled: '0.1.0' }),
      );
    }
  });

  it('001 FR-035 does not check an adapter without adapter.helper', () => {
    expect(helperOutdated([{ variant: 'current', helper: undefined }], PLACE)).toEqual([]);
  });
});
