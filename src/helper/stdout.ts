import process from 'node:process';

// helper-api §stdout Protection. Runs at import, before any service module is evaluated, so
// output the service prints while it loads already goes to stderr. `console` writes through
// `process.stdout.write`, so it follows. Node cannot swap file descriptors, so output that
// native modules or child processes write to descriptor 1 is left to the tool, which reports
// it as stdout contamination.

const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = ((...args: Parameters<typeof stderrWrite>) =>
  stderrWrite(...args)) as typeof process.stdout.write;

/** Writes protocol output to the real stdout; settles when the data was handed to the OS. */
export function writeProtocol(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdoutWrite(text, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
