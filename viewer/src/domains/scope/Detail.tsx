import type { ReactNode } from 'react';

import styles from './Detail.module.css';

interface DetailListProps {
  readonly children: ReactNode;
}

export function DetailList({ children }: DetailListProps) {
  return <dl className={styles.list}>{children}</dl>;
}

interface DetailProps {
  readonly term: string;
  readonly children: ReactNode;
}

/** One term and its value inside a `DetailList`. */
export function Detail({ term, children }: DetailProps) {
  return (
    <div className={styles.detail}>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}
