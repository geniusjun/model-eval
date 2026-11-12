import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../../../viewer/src/i18n/en.json';
import ko from '../../../viewer/src/i18n/ko.json';
import { RootErrorBoundary } from '../../../viewer/src/pages/RootErrorBoundary.js';

function BrokenRegion(): never {
  throw new Error('a region failed to render');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('002 RootErrorBoundary', () => {
  it('002 FR-012 shows the error screen when a region throws while rendering', () => {
    // React reports the caught error on the console; the screen is what this test checks.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RootErrorBoundary lang="en">
        <BrokenRegion />
      </RootErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: en['invalid.heading'] })).toBeDefined();
    expect(screen.getByText(en['invalid.render'])).toBeDefined();
    expect(screen.getByRole('combobox', { name: en['language.label'] })).toBeDefined();
  });

  it('002 FR-013 shows the error screen in the payload language', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RootErrorBoundary lang="ko">
        <BrokenRegion />
      </RootErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1, name: ko['invalid.heading'] })).toBeDefined();
    expect(screen.getByText(ko['invalid.render'])).toBeDefined();
  });

  it('002 FR-012 renders its children when nothing throws', () => {
    render(
      <RootErrorBoundary lang="en">
        <p>report</p>
      </RootErrorBoundary>,
    );
    expect(screen.getByText('report')).toBeDefined();
    expect(screen.queryByRole('heading', { name: en['invalid.heading'] })).toBeNull();
  });
});
