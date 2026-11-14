import { useId, type ChangeEvent } from 'react';

import type { Lang } from '../../../src/config/schema.js';
import { isLang } from '../../../src/messages/index.js';
import { useHashParam } from '../hooks/useHashParam.js';
import { pageMessages } from '../i18n/useMessages.js';
import styles from './LanguageSwitch.module.css';

const LANGS: readonly Lang[] = ['en', 'ko'];

interface LanguageSwitchProps {
  /** The current page language. */
  readonly lang: Lang;
}

/** Writes the chosen language into the hash as `?lang=`, keeping the view (page-data §Location Hash). */
export function LanguageSwitch({ lang }: LanguageSwitchProps) {
  const id = useId();
  const [hash, setHash] = useHashParam();
  const messages = pageMessages(lang);
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (isLang(next)) {
      setHash({ view: hash.view, lang: next });
    }
  };
  return (
    <div className={styles.switch}>
      <label htmlFor={id} className={styles.label}>
        {messages.text('language.label')}
      </label>
      <select id={id} className={styles.select} value={lang} onChange={handleChange}>
        {LANGS.map((option) => (
          <option key={option} value={option}>
            {messages.text(`language.${option}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
