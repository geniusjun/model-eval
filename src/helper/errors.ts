import { isJsonObject, type JsonObject, type JsonValue } from '../adapter/json-types.js';

// helper-api §Error Classification, §Transport Exceptions and §`retryAfterMs`; data-model
// §Call Outcome.

/** The error kinds of a model call failure. */
export type ErrorKind = 'transient' | 'timeout' | 'permanent' | 'config';

/**
 * The kind of a failure without a status code, as `ModelCallError({ kind })` names it:
 * `connect` (never arrived), `tls` (certificate verification), `disconnect` (dropped after
 * sending, or a read time-out on a non-stream body) and `timeout` (a time limit or a cancel).
 */
export type TransportKind = 'connect' | 'tls' | 'disconnect' | 'timeout';

/** The `type`, code and `message` of a provider error object. */
export interface ErrorObject {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
}

/**
 * How a call failed: an error response (`status`, 200 for a response that ended in failure)
 * or a failure without a status code (`transport`). `notJson` marks a non-stream 2xx body read
 * to the end that is not a JSON object, `badScheme` a request URL without an http or https
 * scheme that was never sent.
 */
export interface FailureCause {
  readonly status?: number;
  readonly transport?: TransportKind;
  readonly notJson?: boolean;
  readonly badScheme?: boolean;
}

const QUOTA_CODES: ReadonlySet<string> = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'usage_limit_exceeded',
  'billing_not_active',
]);

const ACCOUNT_CODES: ReadonlySet<string> = new Set([
  'enforced_spend_limit_reached',
  'organization_on_hold',
  'claude_code_key_creator_not_member',
  'claude_code_version_too_old',
  'cmek_key_disabled',
  'cmek_key_network_blocked',
  'skill_read_blocked_undecryptable',
]);

const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'server_error',
  'rate_limit_exceeded',
  'api_error',
  'overloaded_error',
  'rate_limit_error',
  'timeout_error',
]);

const BILLING_PHRASES = ['credit balance', 'usage limit'];

const TRANSPORT_KINDS: Readonly<Record<TransportKind, ErrorKind>> = {
  connect: 'transient',
  tls: 'config',
  disconnect: 'transient',
  timeout: 'timeout',
};

/**
 * The X509 certificate error code table of the Node `tls` module documentation, and the
 * hostname mismatch Node reports for a certificate that does not name the host.
 */
export const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const NOT_REACHED_SYSCALLS: ReadonlySet<string> = new Set(['connect', 'getaddrinfo']);

/** The error object's `type`, its code (OpenAI `code`, else Anthropic `details.error_code`) and `message`. */
export function errorObjectOf(value: JsonValue | undefined): ErrorObject {
  if (!isJsonObject(value)) {
    return {};
  }
  const details = value['details'];
  const code =
    textOf(value['code']) || (isJsonObject(details) ? textOf(details['error_code']) : undefined);
  const type = textOf(value['type']);
  const message = textOf(value['message']);
  return {
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

/**
 * The error object of a failure end event: its `error` when that is a non-empty object, else
 * the event itself. An event whose own `type` is `error` carries the event name there, so that
 * `type` is not taken as an error type.
 */
export function eventErrorObject(payload: JsonObject): JsonObject {
  const nested = payload['error'];
  if (isJsonObject(nested) && Object.keys(nested).length > 0) {
    return nested;
  }
  const error: Record<string, JsonValue> = {};
  for (const name of ['code', 'message']) {
    const value = payload[name];
    if (value !== undefined) {
      error[name] = value;
    }
  }
  const type = payload['type'];
  if (type !== undefined && type !== null && type !== 'error') {
    error['type'] = type;
  }
  return error;
}

/**
 * The error kind of a failure: an error response's status (200 for a response that ended in
 * failure) with its error object, or a transport kind. The first matching row decides.
 */
export function classify(
  status: number | undefined,
  error: ErrorObject,
  transport: TransportKind | undefined,
): ErrorKind {
  if (status === undefined) {
    return TRANSPORT_KINDS[transport ?? 'disconnect'];
  }
  const failedOk = status === 200;
  const { type, code } = error;
  if (
    (status === 429 || failedOk) &&
    (type === 'insufficient_quota' ||
      code === 'insufficient_quota' ||
      (code !== undefined && QUOTA_CODES.has(code)))
  ) {
    return 'config';
  }
  if (
    (status === 429 || status === 400 || status === 409 || failedOk) &&
    code !== undefined &&
    ACCOUNT_CODES.has(code)
  ) {
    return 'config';
  }
  if (status === 404 && code === 'thread_not_found') {
    return 'permanent';
  }
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return 'config';
  }
  const text = (error.message ?? '').toLowerCase();
  if (
    (status === 400 || failedOk) &&
    (type === 'billing_error' || BILLING_PHRASES.some((phrase) => text.includes(phrase)))
  ) {
    return 'config';
  }
  if (status === 429 || (status >= 500 && status <= 599) || status === 408) {
    return 'transient';
  }
  if (
    failedOk &&
    ((type !== undefined && TRANSIENT_FAILURE_CODES.has(type)) ||
      (code !== undefined && TRANSIENT_FAILURE_CODES.has(code)))
  ) {
    return 'transient';
  }
  return 'permanent';
}

/** The error kind of a captured call's failure, with the rows that need no error object. */
export function failureKind(cause: FailureCause, error: ErrorObject): ErrorKind {
  if (cause.notJson === true || cause.badScheme === true) {
    return 'config';
  }
  return classify(cause.status, error, cause.transport);
}

/**
 * data-model §Call Outcome of a failed call: priced at its usage when it has one; charged the
 * call reservation when it may have been billed (a failed 200 response, a drop, time-out or
 * cancel after sending); else not billed. Calls cut on the tool's `cancel` are `unanswered`
 * whatever their failure, which the caller decides.
 */
export function failureOutcome(
  cause: FailureCause,
  usage: object | undefined,
): 'failed' | 'unanswered' {
  if (usage !== undefined) {
    return 'failed';
  }
  if (cause.status === 200 || cause.transport === 'disconnect' || cause.transport === 'timeout') {
    return 'unanswered';
  }
  return 'failed';
}

/**
 * The kind of a `fetch` that failed, read from the error and its `cause` chain, including the
 * errors inside an `AggregateError` (a connection tried on several addresses). `aborted` is
 * whether the request's `signal` was aborted; `stream` whether the failure came while reading
 * an SSE body, where a body time-out is a time limit between events.
 */
export function transportKind(
  error: unknown,
  context: { readonly aborted: boolean; readonly stream: boolean },
): TransportKind {
  const chain = causeChain(error);
  if (context.aborted || isAbortError(error)) {
    return 'timeout';
  }
  const codes = chain.map(codeOf);
  if (codes.some((code) => code !== undefined && CERTIFICATE_CODES.has(code))) {
    return 'tls';
  }
  if (
    codes.includes('UND_ERR_CONNECT_TIMEOUT') ||
    chain.some((item) => NOT_REACHED_SYSCALLS.has(syscallOf(item) ?? ''))
  ) {
    return 'connect';
  }
  if (codes.includes('UND_ERR_HEADERS_TIMEOUT')) {
    return 'timeout';
  }
  if (codes.includes('UND_ERR_BODY_TIMEOUT')) {
    return context.stream ? 'timeout' : 'disconnect';
  }
  return 'disconnect';
}

/** Whether the error, or one in its `cause` chain, is the `AbortError` of an aborted signal. */
export function isAbortError(error: unknown): boolean {
  return causeChain(error).some((item) => nameOf(item) === 'AbortError');
}

function causeChain(error: unknown): unknown[] {
  const found: unknown[] = [];
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current === null || found.includes(current)) {
      continue;
    }
    found.push(current);
    if (typeof current !== 'object') {
      continue;
    }
    if ('cause' in current) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...(current.errors as unknown[]));
    }
  }
  return found;
}

function propertyOf(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(name in value)) {
    return undefined;
  }
  const property: unknown = (value as Record<string, unknown>)[name];
  return typeof property === 'string' ? property : undefined;
}

function codeOf(value: unknown): string | undefined {
  return propertyOf(value, 'code');
}

function syscallOf(value: unknown): string | undefined {
  return propertyOf(value, 'syscall');
}

function nameOf(value: unknown): string | undefined {
  return propertyOf(value, 'name');
}

function textOf(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// --- retryAfterMs ---------------------------------------------------------------------------

/** Response headers as `fetch` gives them; a lookup by lowercase name. */
export interface HeaderLookup {
  get(name: string): string | null | undefined;
}

const DECIMAL = /^[0-9]+(?:\.[0-9]+)?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = `(${MONTHS.join('|')})`;
const TIME = '([0-9]{2}):([0-9]{2}):([0-9]{2})';
const SHORT_DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const DAY_NAME = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
// RFC 9110 §5.6.7: IMF-fixdate, the obsolete RFC 850 form and the asctime form, all in GMT.
const IMF_FIXDATE = new RegExp(`^${SHORT_DAY}, ([0-9]{2}) ${MONTH} ([0-9]{4}) ${TIME} GMT$`);
const RFC_850_DATE = new RegExp(`^${DAY_NAME}, ([0-9]{2})-${MONTH}-([0-9]{2}) ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${SHORT_DAY} ${MONTH} ([0-9 ][0-9]) ${TIME} ([0-9]{4})$`);

/**
 * The wait a response asks for, in ms: `retry-after-ms` when readable, else `retry-after` as
 * seconds or as an HTTP date; undefined when neither is readable.
 */
export function retryAfterMs(
  headers: HeaderLookup,
  nowMs: number = Date.now(),
): number | undefined {
  const inMs = headers.get('retry-after-ms');
  if (typeof inMs === 'string') {
    const waited = readNumber(inMs, 1);
    if (waited !== undefined) {
      return waited;
    }
  }
  const value = headers.get('retry-after');
  if (typeof value !== 'string') {
    return undefined;
  }
  const seconds = readNumber(value, 1000);
  if (seconds !== undefined) {
    return seconds;
  }
  const dateMs = httpDateMs(trimHeader(value), nowMs);
  return dateMs === undefined ? undefined : Math.max(0, rounded(dateMs - nowMs));
}

/** A non-negative decimal times `scale`, rounded half up; undefined for any other text. */
function readNumber(value: string, scale: number): number | undefined {
  const text = trimHeader(value);
  if (!DECIMAL.test(text)) {
    return undefined;
  }
  return waitMs(Number(text) * scale);
}

const LARGEST_INTEGER = Number.MAX_SAFE_INTEGER;
const EXACT_INTEGERS_FROM = 2 ** 52;

/**
 * A wait in ms as a non-negative integer, or undefined when it cannot be one: negative, not
 * finite, or above 2^53-1 after rounding. Halves round up; from 2^52 on every double is already an
 * integer, and adding 0.5 there could round past it, so the value is kept as it is.
 */
export function waitMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const whole = value >= EXACT_INTEGERS_FROM ? value : Math.floor(value + 0.5);
  return whole > LARGEST_INTEGER ? undefined : whole;
}

/** The value without SP and HTAB at either end, the optional whitespace of RFC 9110. */
function trimHeader(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** floor(x + 0.5): halves round up in both helpers. */
function rounded(value: number): number {
  return Math.floor(value + 0.5);
}

/** The time an HTTP date names, in ms since the epoch, read as GMT in all three forms. */
function httpDateMs(text: string, nowMs: number): number | undefined {
  let match = IMF_FIXDATE.exec(text);
  if (match !== null) {
    const [, day, month, year, hour, minute, second] = match as unknown as string[];
    return utcMs(Number(year), month, day, hour, minute, second);
  }
  match = RFC_850_DATE.exec(text);
  if (match !== null) {
    const [, day, month, shortYear, hour, minute, second] = match as unknown as string[];
    return rfc850Ms(Number(shortYear), [month, day, hour, minute, second], nowMs);
  }
  match = ASCTIME_DATE.exec(text);
  if (match !== null) {
    const [, month, day, hour, minute, second, year] = match as unknown as string[];
    return utcMs(Number(year), month, day?.trim(), hour, minute, second);
  }
  return undefined;
}

/**
 * RFC 9110 §5.6.7: the date in the year with these last two digits that lies more than 50
 * years before now and at most 50 years after it, compared by instant.
 */
function rfc850Ms(
  shortYear: number,
  rest: readonly (string | undefined)[],
  nowMs: number,
): number | undefined {
  const earliest = yearsFrom(nowMs, -50);
  const latest = yearsFrom(nowMs, 50);
  const century = Math.floor(new Date(nowMs).getUTCFullYear() / 100) * 100;
  const [month, day, hour, minute, second] = rest;
  for (const year of [century - 100 + shortYear, century + shortYear, century + 100 + shortYear]) {
    const moment = utcMs(year, month, day, hour, minute, second);
    if (moment !== undefined && earliest < moment && moment <= latest) {
      return moment;
    }
  }
  return undefined;
}

/** The instant `years` calendar years from now; 29 February moves to 28 February. */
function yearsFrom(nowMs: number, years: number): number {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear() + years;
  const month = now.getUTCMonth();
  const day = Math.min(now.getUTCDate(), daysInMonth(year, month));
  const shifted = new Date(nowMs);
  shifted.setUTCFullYear(year, month, day);
  return shifted.getTime();
}

/**
 * Milliseconds since the epoch of a date in years 1 to 9999, or undefined for a date that does
 * not exist (30 February, second 60). `Date.UTC` would roll those into the next unit, and maps
 * years below 100 into the 1900s.
 */
function utcMs(
  year: number,
  monthName: string | undefined,
  dayText: string | undefined,
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined,
): number | undefined {
  const month = MONTHS.indexOf(monthName ?? '');
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || year > 9999 || month < 0 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const moment = new Date(0);
  moment.setUTCFullYear(year, month, day);
  moment.setUTCHours(hour, minute, second, 0);
  return moment.getTime();
}

function daysInMonth(year: number, month: number): number {
  if (month === 1) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 31;
}
