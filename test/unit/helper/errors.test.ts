import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CERTIFICATE_CODES,
  classify,
  errorObjectOf,
  eventErrorObject,
  failureKind,
  failureOutcome,
  retryAfterMs,
  transportKind,
  waitMs,
} from '../../../src/helper/errors.js';

const VALUES = fileURLToPath(new URL('../../fixtures/helper/parity/values.json', import.meta.url));

const retryAfterSchema = z.object({
  nowMs: z.number(),
  cases: z.array(
    z.object({
      name: z.string(),
      headers: z.record(z.string(), z.string()),
      nowMs: z.number().optional(),
      retryAfterMs: z.number().nullable(),
    }),
  ),
});

const retryAfter = retryAfterSchema.parse(
  (JSON.parse(readFileSync(VALUES, 'utf8')) as { retryAfter: unknown }).retryAfter,
);

/** A plain lookup: `Headers` would trim the line feed and refuse U+3000 the vectors carry. */
function headersOf(headers: Readonly<Record<string, string>>) {
  return new Map(Object.entries(headers));
}

const STREAM = { aborted: false, stream: true };
const BODY = { aborted: false, stream: false };

function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function systemError(code: string, syscall?: string): Error {
  return Object.assign(new Error(code), { code, ...(syscall === undefined ? {} : { syscall }) });
}

describe('retryAfterMs', () => {
  it.each(retryAfter.cases)('003 FR-024 $name', ({ headers, nowMs, retryAfterMs: expected }) => {
    expect(retryAfterMs(headersOf(headers), nowMs ?? retryAfter.nowMs)).toBe(expected ?? undefined);
  });

  it('003 FR-024 waits are rounded half up and kept at most 2^53-1', () => {
    expect(waitMs(2.5)).toBe(3);
    expect(waitMs(0.49)).toBe(0);
    expect(waitMs(2 ** 52)).toBe(2 ** 52);
    expect(waitMs(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(waitMs(2 ** 53)).toBeUndefined();
    expect(waitMs(-1)).toBeUndefined();
    expect(waitMs(Number.NaN)).toBeUndefined();
    expect(waitMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('003 FR-007 reads fetch Headers by any name case', () => {
    expect(retryAfterMs(new Headers({ 'Retry-After': '3' }))).toBe(3000);
  });
});

describe('error classification', () => {
  it.each([
    [429, { code: 'insufficient_quota' }, 'config'],
    [200, { type: 'insufficient_quota' }, 'config'],
    [429, { code: 'billing_not_active' }, 'config'],
    [400, { code: 'insufficient_quota' }, 'permanent'],
    [409, { code: 'enforced_spend_limit_reached' }, 'config'],
    [200, { code: 'organization_on_hold' }, 'config'],
    [404, { code: 'thread_not_found' }, 'permanent'],
    [404, {}, 'config'],
    [402, {}, 'config'],
    [400, { type: 'billing_error' }, 'config'],
    [400, { message: 'Your Credit Balance is too low' }, 'config'],
    [200, { message: 'usage limit reached' }, 'config'],
    [429, { message: 'credit balance' }, 'transient'],
    [408, {}, 'transient'],
    [529, { type: 'overloaded_error' }, 'transient'],
    [200, { type: 'overloaded_error' }, 'transient'],
    [200, { code: 'rate_limit_exceeded' }, 'transient'],
    [200, { type: 'invalid_request_error' }, 'permanent'],
    [409, {}, 'permanent'],
    [422, {}, 'permanent'],
  ] as const)('003 FR-017 status %i with %o is %s', (status, error, kind) => {
    expect(classify(status, error, undefined)).toBe(kind);
  });

  it.each([
    ['connect', 'transient'],
    ['tls', 'config'],
    ['disconnect', 'transient'],
    ['timeout', 'timeout'],
  ] as const)('003 FR-017 transport %s is %s', (transport, kind) => {
    expect(classify(undefined, {}, transport)).toBe(kind);
  });

  it('003 FR-017 a body that is not JSON and a URL without http are config', () => {
    expect(failureKind({ status: 200, notJson: true }, {})).toBe('config');
    expect(failureKind({ transport: 'connect', badScheme: true }, {})).toBe('config');
  });

  it('003 FR-017 the code comes from code, else from details.error_code', () => {
    expect(errorObjectOf({ type: 'error', code: 'x', message: 'm' })).toEqual({
      type: 'error',
      code: 'x',
      message: 'm',
    });
    expect(errorObjectOf({ code: '', details: { error_code: 'organization_on_hold' } })).toEqual({
      code: 'organization_on_hold',
    });
    expect(errorObjectOf({ code: 7, type: null })).toEqual({});
    expect(errorObjectOf('error')).toEqual({});
  });

  it('003 FR-017 an error event without a nested error is read from the event itself', () => {
    expect(eventErrorObject({ type: 'error', code: 'server_error', message: 'm' })).toEqual({
      code: 'server_error',
      message: 'm',
    });
    expect(eventErrorObject({ type: 'error', error: {}, code: 'c' })).toEqual({ code: 'c' });
    expect(eventErrorObject({ type: 'error', error: { type: 'overloaded_error' } })).toEqual({
      type: 'overloaded_error',
    });
  });
});

describe('transport exceptions', () => {
  it.each([...CERTIFICATE_CODES])('003 FR-017 certificate code %s is tls', (code) => {
    expect(transportKind(fetchFailed(systemError(code)), BODY)).toBe('tls');
  });

  it('003 FR-017 the certificate list is the Node tls table and the hostname mismatch', () => {
    expect(CERTIFICATE_CODES.size).toBe(29);
    expect(CERTIFICATE_CODES).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('003 FR-017 a request that never arrived is connect', () => {
    const refused = systemError('ECONNREFUSED', 'connect');
    expect(transportKind(fetchFailed(refused), BODY)).toBe('connect');
    const notFound = systemError('ENOTFOUND', 'getaddrinfo');
    expect(transportKind(fetchFailed(notFound), BODY)).toBe('connect');
    const timedOut = systemError('UND_ERR_CONNECT_TIMEOUT');
    expect(transportKind(fetchFailed(timedOut), BODY)).toBe('connect');
    // localhost tried on both address families: the syscall sits on the inner errors.
    const everyAddress = Object.assign(new AggregateError([refused, refused]), {
      code: 'ECONNREFUSED',
    });
    expect(transportKind(fetchFailed(everyAddress), BODY)).toBe('connect');
  });

  it('003 FR-017 undici time-outs and socket errors', () => {
    expect(transportKind(fetchFailed(systemError('UND_ERR_HEADERS_TIMEOUT')), BODY)).toBe(
      'timeout',
    );
    expect(transportKind(systemError('UND_ERR_BODY_TIMEOUT'), STREAM)).toBe('timeout');
    expect(transportKind(systemError('UND_ERR_BODY_TIMEOUT'), BODY)).toBe('disconnect');
    expect(transportKind(fetchFailed(systemError('UND_ERR_SOCKET')), BODY)).toBe('disconnect');
    expect(transportKind(new Error('unknown'), BODY)).toBe('disconnect');
  });

  it('003 FR-017 an aborted request is a cancel, a time limit', () => {
    expect(transportKind(new DOMException('aborted', 'AbortError'), BODY)).toBe('timeout');
    expect(transportKind(new Error('reason'), { aborted: true, stream: false })).toBe('timeout');
  });
});

describe('call outcome', () => {
  it.each([
    [{ status: 429 }, undefined, 'failed'],
    [{ status: 200 }, undefined, 'unanswered'],
    [{ status: 200 }, { input: 3 }, 'failed'],
    [{ transport: 'connect' }, undefined, 'failed'],
    [{ transport: 'tls' }, undefined, 'failed'],
    [{ transport: 'connect', badScheme: true }, undefined, 'failed'],
    [{ transport: 'disconnect' }, undefined, 'unanswered'],
    [{ transport: 'timeout' }, undefined, 'unanswered'],
  ] as const)('003 FR-007 %o with usage %o is %s', (cause, usage, outcome) => {
    expect(failureOutcome(cause, usage)).toBe(outcome);
  });
});
