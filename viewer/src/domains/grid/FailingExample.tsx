import type { Samples, SampleText } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import type { Messages } from '../../i18n/useMessages.js';
import type { VariantIds } from '../../report/variants.js';
import styles from './CellDetail.module.css';

export type FailingKey = Samples['failing'][number]['keys'][number];

interface FailingExampleProps {
  readonly sampleKey: FailingKey;
  /** The text stored under the key, or undefined when `samples.texts` holds none. */
  readonly text: SampleText | undefined;
  readonly variants: VariantIds;
  readonly messages: Messages;
}

interface SampleBlockProps {
  readonly label: string;
  readonly text: string;
}

function SampleBlock({ label, text }: SampleBlockProps) {
  return (
    <div className={styles.sample}>
      <p className={styles.sampleLabel}>{label}</p>
      <div className={styles.sampleText}>
        <CodeText text={text} />
      </div>
    </div>
  );
}

interface EvidenceProps {
  readonly evidence: readonly string[];
  readonly messages: Messages;
}

function Evidence({ evidence, messages }: EvidenceProps) {
  return (
    <p className={styles.evidence}>
      <span>{messages.text('grid.sample.evidence')}</span>{' '}
      {evidence.map((item, index) => (
        <span key={index} className={styles.evidenceItem}>
          <CodeText text={item} />
        </span>
      ))}
    </p>
  );
}

interface SampleBodyProps {
  readonly text: SampleText;
  readonly messages: Messages;
}

function SampleBody({ text, messages }: SampleBodyProps) {
  if ('error' in text) {
    return (
      <SampleBlock
        label={messages.text('grid.sample.error', { kind: text.error.kind })}
        text={text.error.message}
      />
    );
  }
  return (
    <>
      <SampleBlock
        label={messages.text('grid.sample.raw', { finishReason: text.finishReason })}
        text={text.raw}
      />
      {text.final === undefined ? (
        <p className={styles.sampleLabel}>
          {messages.text('grid.sample.noFinal', { finalKind: text.finalKind })}
        </p>
      ) : (
        <SampleBlock
          label={messages.text('grid.sample.final', { finalKind: text.finalKind })}
          text={text.final}
        />
      )}
    </>
  );
}

/** One failing example of a cell: where it comes from, its evidence, and raw and final text. */
export function FailingExample({ sampleKey, text, variants, messages }: FailingExampleProps) {
  const evidence = sampleKey.evidence ?? [];
  return (
    <>
      <p className={styles.exampleKey}>
        {messages.text('grid.sample.key', {
          variant: variants[sampleKey.variant],
          caseId: sampleKey.caseId,
          repeat: sampleKey.repeat,
        })}
      </p>
      {evidence.length > 0 && <Evidence evidence={evidence} messages={messages} />}
      {text !== undefined && <SampleBody text={text} messages={messages} />}
    </>
  );
}
