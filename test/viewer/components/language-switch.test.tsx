import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import en from '../../../viewer/src/i18n/en.json';
import ko from '../../../viewer/src/i18n/ko.json';
import { LanguageSwitch } from '../../../viewer/src/components/LanguageSwitch.js';

afterEach(() => {
  window.location.hash = '';
});

describe('002 LanguageSwitch', () => {
  it('002 FR-013 is a labelled control that writes ?lang= into the hash', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/cell/script-ja/ja/raw';
    const { rerender } = render(<LanguageSwitch lang="en" />);
    await user.selectOptions(screen.getByRole('combobox', { name: en['language.label'] }), 'ko');
    expect(window.location.hash).toBe('#/cell/script-ja/ja/raw?lang=ko');
    rerender(<LanguageSwitch lang="ko" />);
    await user.selectOptions(screen.getByRole('combobox', { name: ko['language.label'] }), 'en');
    expect(window.location.hash).toBe('#/cell/script-ja/ja/raw?lang=en');
  });

  it('002 FR-013 labels the control in the page language', () => {
    render(<LanguageSwitch lang="ko" />);
    expect(screen.getByRole('combobox', { name: ko['language.label'] })).toBeDefined();
  });
});
