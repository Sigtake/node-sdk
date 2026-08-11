export interface SigtakeErrorInit {
  status: number;
  code?: string | undefined;
  requestId?: string | undefined;
  body?: unknown;
  cause?: unknown;
}

export class SigtakeError extends Error {
  /** HTTP status, or 0 for client-side failures (network, timeout, local validation). */
  readonly status: number;
  readonly code: string | undefined;
  /** The API exposes no correlation header today; reserved. */
  readonly requestId: string | undefined;
  /** The raw parsed response body, untransformed. */
  readonly body: unknown;

  constructor(message: string, init: SigtakeErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.body = init.body;
    // Keeps `instanceof` working when consumers downlevel to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — missing, invalid or disabled API key. */
export class SigtakeAuthError extends SigtakeError {}

/** 400, the 422 total rejection of signals, and local input validation (status 0). */
export class SigtakeValidationError extends SigtakeError {
  /** Zod's `flatten().fieldErrors`, only sent by `POST /api/ingest`. */
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(
    message: string,
    init: SigtakeErrorInit & { fieldErrors?: Record<string, string[]> | undefined },
  ) {
    super(message, init);
    this.fieldErrors = init.fieldErrors;
  }
}

/** 404 — no monitor matches that `source` for this API key's project. */
export class SigtakeNotFoundError extends SigtakeError {}

/** 409 — the monitor is paused. */
export class SigtakeConflictError extends SigtakeError {}

/** 429 — raised only after the retry budget is exhausted. */
export class SigtakeRateLimitError extends SigtakeError {
  /** Seconds from `Retry-After`, when the server sends one. */
  readonly retryAfter: number | undefined;

  constructor(message: string, init: SigtakeErrorInit & { retryAfter?: number | undefined }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/** 5xx. */
export class SigtakeServerError extends SigtakeError {}

/** DNS failure, connection reset, or the per-attempt timeout firing. */
export class SigtakeNetworkError extends SigtakeError {}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readFieldErrors(record: Record<string, unknown>): Record<string, string[]> | undefined {
  const errors = record['errors'];
  if (typeof errors !== 'object' || errors === null || Array.isArray(errors)) return undefined;
  return errors as Record<string, string[]>;
}

/**
 * Maps a non-2xx response to its error class.
 *
 * The two ingestion endpoints disagree on the error key — `/api/ingest` answers
 * `{ message }` while `/api/signals/ingest` answers `{ error }`, and the shared
 * rate limiter answers `{ message }` on both. Reading only one of them yields
 * `undefined` messages against the other endpoint.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  meta: { requestId?: string | undefined; retryAfter?: number | undefined } = {},
): SigtakeError {
  const record = asRecord(body);
  const message =
    readString(record, 'message') ??
    readString(record, 'error') ??
    `Sigtake API request failed with status ${status}`;

  const init: SigtakeErrorInit = {
    status,
    code: readString(record, 'code'),
    requestId: meta.requestId,
    body,
  };

  if (status === 401 || status === 403) return new SigtakeAuthError(message, init);
  if (status === 404) return new SigtakeNotFoundError(message, init);
  if (status === 409) return new SigtakeConflictError(message, init);
  if (status === 429) {
    return new SigtakeRateLimitError(message, { ...init, retryAfter: meta.retryAfter });
  }
  if (status >= 500) return new SigtakeServerError(message, init);
  if (status === 400 || status === 422) {
    return new SigtakeValidationError(message, { ...init, fieldErrors: readFieldErrors(record) });
  }
  return new SigtakeError(message, init);
}

/** Local, pre-flight validation failure. Never left the process, hence status 0. */
export function localValidationError(message: string): SigtakeValidationError {
  return new SigtakeValidationError(message, { status: 0 });
}
