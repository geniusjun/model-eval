import type { ReactNode } from 'react';

import styles from './Disclosure.module.css';

interface DisclosureProps {
  /** What opening it shows, as the text of its summary. */
  readonly label: string;
  readonly children: ReactNode;
}

/**
 * Supporting detail that starts closed, so the page leads with what decides. It stays in the
 * document while closed, and the browser's own `<details>` opens it by mouse or keyboard.
 */
export function Disclosure({ label, children }: DisclosureProps) {
  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>{label}</summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
