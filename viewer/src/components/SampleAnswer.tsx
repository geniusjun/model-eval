import type { Lang } from '../../../src/config/schema.js';
import type { SampleText } from '../../../src/report/schema.js';
import { pageMessages } from '../i18n/useMessages.js';
import { CodeText } from './CodeText.js';
import { MarkedText } from './MarkedText.js';
import styles from './SampleAnswer.module.css';

interface LabelledTextProps {
  readonly label: string;
  readonly text: string;
  readonly marks: readonly string[];
  readonly markLabel: string;
}

/** The text as one text node, or with its evidence marked when there is any (plan D5 item 3). */
function LabelledText({ label, text, marks, markLabel }: LabelledTextProps) {
  return (
    <div className={styles.sample}>
      <p className={styles.label}>{label}</p>
      <div className={styles.answer}>
        {marks.length === 0 ? (
          <CodeText text={text} />
        ) : (
          <MarkedText text={text} marks={marks} markLabel={markLabel} />
        )}
      </div>
    </div>
  );
}

interface SampleAnswerProps {
  readonly text: SampleText;
  readonly lang: Lang;
  /** Evidence of a failure to mark in the answer, when the answer failed. */
  readonly marks?: readonly string[];
}

/**
 * One stored trial text: raw and final with how each came about in words, or an error's kind
 * and message. When the service shipped the raw answer unchanged, one box says so.
 */
export function SampleAnswer({ text, lang, marks = [] }: SampleAnswerProps) {
  const messages = pageMessages(lang);
  if ('error' in text) {
    return (
      <LabelledText
        label={messages.text('sample.error', { kind: text.error.kind })}
        text={text.error.message}
        marks={marks}
        markLabel={messages.text('summary.examples.marked')}
      />
    );
  }
  const finishReason = messages.text(`sample.finish.${text.finishReason}`);
  const finalKind = messages.text(`sample.finalKind.${text.finalKind}`);
  const markLabel = messages.text('summary.examples.marked');
  if (text.final === text.raw) {
    return (
      <LabelledText
        label={messages.text('sample.same', { finishReason })}
        text={text.raw}
        marks={marks}
        markLabel={markLabel}
      />
    );
  }
  return (
    <>
      <LabelledText
        label={messages.text('sample.raw', { finishReason })}
        text={text.raw}
        marks={marks}
        markLabel={markLabel}
      />
      {text.final === undefined ? (
        <p className={styles.label}>{messages.text('sample.noFinal', { finalKind })}</p>
      ) : (
        <LabelledText
          label={messages.text('sample.final', { finalKind })}
          text={text.final}
          marks={marks}
          markLabel={markLabel}
        />
      )}
    </>
  );
}
