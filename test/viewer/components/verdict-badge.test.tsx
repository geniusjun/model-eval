import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { verdictSchema, type Verdict } from '../../../src/report/schema.js';
import { VerdictBadge } from '../../../viewer/src/components/VerdictBadge.js';

/** The display names of 001 data-model §Cell. */
const DISPLAY_NAMES: Readonly<Record<Verdict, string>> = {
  improved: 'Better',
  'non-inferior': 'Held',
  regressed: 'Regressed',
  inconclusive: 'Inconclusive',
  insufficient: 'Too few samples',
  'not-applicable': 'Not applicable',
};

describe('002 VerdictBadge', () => {
  it('002 FR-003 states each verdict as text, with a colour class of its own', () => {
    const classes = new Set<string>();
    for (const verdict of verdictSchema.options) {
      const { container, unmount } = render(<VerdictBadge verdict={verdict} lang="en" />);
      const badge = container.firstElementChild;
      expect(badge?.textContent, verdict).toBe(DISPLAY_NAMES[verdict]);
      expect(badge?.classList.contains(verdict), verdict).toBe(true);
      classes.add(badge?.className ?? '');
      unmount();
    }
    expect(classes.size).toBe(verdictSchema.options.length);
  });
});
