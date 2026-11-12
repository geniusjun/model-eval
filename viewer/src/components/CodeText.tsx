import styles from './CodeText.module.css';

interface CodeTextProps {
  /** Text from the model, the adapter or the service, shown exactly as written. */
  readonly text: string;
}

/** Untrusted text as one text node, with its newlines kept (plan D5 item 3). */
export function CodeText({ text }: CodeTextProps) {
  return <span className={styles.text}>{text}</span>;
}
