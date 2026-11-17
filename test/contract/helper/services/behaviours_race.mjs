// The `race-report` behaviour: `flow-report` (behaviours_report.mjs) with one more step, named as
// in the Python scenario services (behaviours_race.py), for services that send the same request
// several ways and take the first answer without cancelling the others:
//
// - `{"race": [call, ...]}`: the requests sent together. The service takes the first that
//   succeeds and stops waiting for the rest (`Promise.race`), which keep running; a call still
//   running then is not recorded.

import { ReportFlow, runReport } from './behaviours_report.mjs';
import { firstSettled, startTask } from './support.mjs';

class RaceFlow extends ReportFlow {
  async step(step) {
    if ('race' in step) {
      await this.race(step.race);
    } else {
      await super.step(step);
    }
  }

  async race(specs) {
    // Clients are built first so that `startAfterMs` delays only the send, as in `parallel`.
    const clients = await Promise.all(specs.map((spec) => this.clientFor(spec)));
    const tasks = specs.map((spec, index) =>
      startTask((signal) => this.callAwaited(spec, clients[index], signal)),
    );
    let pending = [...tasks];
    let first;
    const failed = [];
    while (pending.length > 0 && first === undefined) {
      const done = await firstSettled(pending);
      pending = pending.filter((task) => task !== done);
      const spec = specs[tasks.indexOf(done)];
      const received = await done.promise;
      this.record(spec, received);
      if (received.error === undefined) {
        first = received;
      } else {
        failed.push([spec, received]);
      }
    }
    if (first === undefined) {
      this.finish(...failed[0]);
    }
  }
}

async function raceReport(run) {
  return runReport(new RaceFlow(run));
}

export const BEHAVIOURS = { 'race-report': raceReport };
