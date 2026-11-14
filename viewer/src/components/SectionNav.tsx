import { useEffect, useState } from 'react';

import { Shape, type ShapeKind } from './Shape.js';
import styles from './SectionNav.module.css';

/** A count that needs attention, such as regressed cells, shown beside a section's name. */
export interface SectionFlag {
  readonly shape: ShapeKind;
  readonly count: number;
  /** The count in words, read by assistive technology in place of the shape and the number. */
  readonly text: string;
}

export interface SectionLink {
  /** The ID of the section's heading; the heading takes focus when its button is pressed. */
  readonly headingId: string;
  readonly label: string;
  readonly flag?: SectionFlag | undefined;
}

interface SectionNavProps {
  readonly label: string;
  readonly sections: readonly SectionLink[];
}

/** The part of the viewport whose top edge decides the current section. */
const CURRENT_LINE = 0.35;

function sectionOf(headingId: string): HTMLElement | null {
  return document.getElementById(headingId)?.closest('section') ?? null;
}

/** The last section whose top has passed the current line, or the last one at the page end. */
function currentHeadingId(headingIds: readonly string[]): string | undefined {
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  if (atEnd) {
    return headingIds.at(-1);
  }
  const line = window.innerHeight * CURRENT_LINE;
  const passed = headingIds.filter(
    (id) => (sectionOf(id)?.getBoundingClientRect().top ?? Infinity) <= line,
  );
  return passed.at(-1) ?? headingIds[0];
}

/**
 * Buttons that move to each region of the page and focus its heading. They are buttons, not
 * hash links, because the hash holds the reader's view (page-data §Location Hash). The section
 * in view is marked with `aria-current`.
 */
export function SectionNav({ label, sections }: SectionNavProps) {
  const headingKey = sections.map((section) => section.headingId).join(' ');
  const [current, setCurrent] = useState<string | undefined>(sections[0]?.headingId);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const headingIds = headingKey.split(' ');
    const observer = new IntersectionObserver(
      () => {
        setCurrent(currentHeadingId(headingIds));
      },
      { rootMargin: `0px 0px -${String(100 - CURRENT_LINE * 100)}% 0px` },
    );
    for (const id of headingIds) {
      const section = sectionOf(id);
      if (section !== null) {
        observer.observe(section);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, [headingKey]);

  const goTo = (headingId: string) => {
    const heading = document.getElementById(headingId);
    sectionOf(headingId)?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
    setCurrent(headingId);
  };

  return (
    <nav aria-label={label} className={styles.nav}>
      <ul className={styles.list}>
        {sections.map(({ headingId, label: name, flag }) => (
          <li key={headingId}>
            <button
              type="button"
              className={styles.link}
              aria-current={current === headingId ? 'true' : undefined}
              onClick={() => {
                goTo(headingId);
              }}
            >
              {name}
              {flag !== undefined && flag.count > 0 && (
                <span className={styles.flag} data-shape={flag.shape}>
                  <Shape kind={flag.shape} />
                  <span aria-hidden="true">{flag.count}</span>
                  <span className={styles.hidden}>{`, ${flag.text}`}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
