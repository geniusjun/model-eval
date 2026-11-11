import type { CallsParams } from '../adapter/protocol.js';
import type { TrialKey } from './ids.js';

// adapter-protocol §`calls`: a notification names the `generate` request its calls belong to.
// One that arrives before its attempt line is held until that line is written.

export interface RequestTrial {
  readonly key: TrialKey;
  readonly attempt: number;
}

export interface CallsSink {
  /** Calls of a known trial, after its attempt line. */
  keyed(trial: RequestTrial, params: CallsParams): void;
  /** Calls that belong to no known trial. */
  unkeyed(params: CallsParams): void;
}

interface RequestEntry {
  readonly trial: RequestTrial;
  written: boolean;
  readonly held: CallsParams[];
}

export interface CallsRouter {
  /** The `onCalls` callback of the adapter client. */
  receive(params: CallsParams): void;
  /** Starts delivering; notifications received before are delivered now. */
  attach(sink: CallsSink): void;
  /** `generate` request `id` carries this attempt. */
  bind(id: number, trial: RequestTrial): void;
  /** The attempt line of request `id` is written; held notifications follow it. */
  written(id: number): void;
}

export function createCallsRouter(): CallsRouter {
  const requests = new Map<number, RequestEntry>();
  const early: CallsParams[] = [];
  let sink: CallsSink | undefined;

  const deliver = (params: CallsParams): void => {
    if (sink === undefined) {
      early.push(params);
      return;
    }
    const entry = params.id === undefined ? undefined : requests.get(params.id);
    if (entry === undefined) {
      sink.unkeyed(params);
    } else if (entry.written) {
      sink.keyed(entry.trial, params);
    } else {
      entry.held.push(params);
    }
  };

  return {
    receive: deliver,
    attach(next) {
      sink = next;
      for (const params of early.splice(0)) {
        deliver(params);
      }
    },
    bind(id, trial) {
      requests.set(id, { trial, written: false, held: [] });
    },
    written(id) {
      const entry = requests.get(id);
      if (entry === undefined) {
        return;
      }
      entry.written = true;
      for (const params of entry.held.splice(0)) {
        sink?.keyed(entry.trial, params);
      }
    },
  };
}
