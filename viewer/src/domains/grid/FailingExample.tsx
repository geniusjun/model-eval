import type { Samples, SampleText } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { SampleAnswer } from '../../components/SampleAnswer.js';
import type { Messages } from '../../i18n/useMessages.js';
import styles from './CellDetail.module.css';

export type FailingKey = Samples['failing'][number]['keys'][number];

interface FailingExampleProps {
  readonly sampleKey: FailingKey;
  /** The text stored under the key, or undefined when `samples.texts` holds none. */
  readonly text: SampleText | undefined;
  /** The location of this example's case and repeat in the side-by-side view. */
  readonly sideHref: string;
  readonly messages: Messages;
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

/**
 * One failing example of a cell: where it comes from, its evidence, its raw and final text, and
 * a link to the baseline's answer to the same case and repeat side by side.
 */
export function FailingExample({ sampleKey, text, sideHref, messages }: FailingExampleProps) {
  const evidence = sampleKey.evidence ?? [];
  return (
    <>
      <p className={styles.exampleKey}>
        {messages.text('grid.sample.key', {
          variant: messages.text(`role.${sampleKey.variant}`),
          caseId: sampleKey.caseId,
          repeat: sampleKey.repeat,
        })}{' '}
        <a href={sideHref}>{messages.text('side.link')}</a>
      </p>
      {evidence.length > 0 && <Evidence evidence={evidence} messages={messages} />}
      {text !== undefined && <SampleAnswer text={text} lang={messages.lang} />}
    </>
  );
}
