import type { Lang } from '../../../src/config/schema.js';
import type { SampleText } from '../../../src/report/schema.js';
import { pageMessages } from '../i18n/useMessages.js';
import { CodeText } from './CodeText.js';
import styles from './SampleAnswer.module.css';

interface LabelledTextProps {
  readonly label: string;
  readonly text: string;
}

function LabelledText({ label, text }: LabelledTextProps) {
  return (
    <div className={styles.sample}>
      <p className={styles.label}>{label}</p>
      <div className={styles.answer}>
        <CodeText text={text} />
      </div>
    </div>
  );
}

interface SampleAnswerProps {
  readonly text: SampleText;
  readonly lang: Lang;
}

/** One stored trial text: raw and final with their kinds, or an error's kind and message. */
export function SampleAnswer({ text, lang }: SampleAnswerProps) {
  const messages = pageMessages(lang);
  if ('error' in text) {
    return (
      <LabelledText
        label={messages.text('sample.error', { kind: text.error.kind })}
        text={text.error.message}
      />
    );
  }
  return (
    <>
      <LabelledText
        label={messages.text('sample.raw', { finishReason: text.finishReason })}
        text={text.raw}
      />
      {text.final === undefined ? (
        <p className={styles.label}>
          {messages.text('sample.noFinal', { finalKind: text.finalKind })}
        </p>
      ) : (
        <LabelledText
          label={messages.text('sample.final', { finalKind: text.finalKind })}
          text={text.final}
        />
      )}
    </>
  );
}
