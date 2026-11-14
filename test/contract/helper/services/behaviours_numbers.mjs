// The `flow-report-numbers` behaviour: `flow-report` (behaviours_report.mjs) with report values
// that JSON cannot hold, as in the Python scenario services (behaviours_numbers.py). In the
// `throw` fields of `report` and `onException`, a value `{"number": "NaN" | "Infinity" |
// "-Infinity"}` becomes that number, so a fixture can throw
// `new ModelCallError({ retryAfterMs: NaN })` (helper-scenarios S-PAR-11).

import { BEHAVIOURS as REPORT_BEHAVIOURS } from './behaviours_report.mjs';

const NON_FINITE = { NaN, Infinity, '-Infinity': -Infinity };

function number(value) {
  if (typeof value === 'object' && value !== null && Object.keys(value).join() === 'number') {
    return NON_FINITE[value.number];
  }
  return value;
}

function withNumbers(report) {
  if (!('throw' in report)) {
    return report;
  }
  const fields = Object.entries(report.throw).map(([key, value]) => [key, number(value)]);
  return { ...report, throw: Object.fromEntries(fields) };
}

async function flowReportNumbers(run) {
  for (const key of ['report', 'onException']) {
    if (key in run.params) {
      run.params = { ...run.params, [key]: withNumbers(run.params[key]) };
    }
  }
  return REPORT_BEHAVIOURS['flow-report'](run);
}

export const BEHAVIOURS = { 'flow-report-numbers': flowReportNumbers };
