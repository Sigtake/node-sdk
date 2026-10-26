import { randomUUID } from 'node:crypto';
import { SigtakeError, localValidationError } from '../errors.js';
import { sendPing, type PingTransportConfig } from './transport.js';
import type {
  FailOptions,
  Heartbeat,
  HeartbeatOptions,
  HeartbeatRun,
  RunOptions,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://api.sigtake.com';
const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY = 500;
const EXIT_CODE_MAX = 255;
// Mirrors the backend's RID_PATTERN; an invalid rid answers 400 on an on demand check.
const RID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const PING_PATH = /\/ping\/[A-Za-z0-9_-]+$/;

/** Test-only knobs, kept out of the public options. */
export interface HeartbeatInternals {
  retryBaseDelay?: number;
}

function defaultOnError(err: SigtakeError): void {
  console.warn(`[sigtake] heartbeat ping failed: ${err.message}`);
}

function parsePingUrl(pingUrl: string): string {
  let url: URL;
  try {
    url = new URL(pingUrl);
  } catch {
    throw new TypeError(`Sigtake: heartbeat ping URL is not a valid URL: ${pingUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Sigtake: heartbeat ping URL must be an http(s) URL.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('Sigtake: heartbeat ping URL must not carry a query or fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!PING_PATH.test(path)) {
    throw new TypeError('Sigtake: heartbeat ping URL must end in /ping/<token>.');
  }
  return `${url.origin}${path}`;
}

/** Accepts the token alone, or the full ping URL that 0.4.0 required. A full URL ignores `baseUrl`. */
function resolvePingBase(tokenOrUrl: unknown, baseUrl: string | undefined): string {
  if (typeof tokenOrUrl !== 'string' || tokenOrUrl.trim() === '') {
    throw new TypeError('Sigtake: heartbeat `token` is required. Copy it from the heartbeat in Sigtake.');
  }
  const value = tokenOrUrl.trim();
  if (value.includes('/') || value.includes(':')) return parsePingUrl(value);
  if (!TOKEN_PATTERN.test(value)) {
    throw new TypeError('Sigtake: heartbeat `token` is not valid. Copy it from the heartbeat in Sigtake.');
  }
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/ping/${value}`;
}

export function createHeartbeat(
  token: string,
  options: HeartbeatOptions = {},
  internals: HeartbeatInternals = {},
): Heartbeat {
  const base = resolvePingBase(token, options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'Sigtake: global fetch is unavailable. Use Node 18 or newer, or pass `fetch` explicitly.',
    );
  }
  const transport: PingTransportConfig = {
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    fetch: fetchImpl,
    retryBaseDelay: internals.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY,
  };
  const onError = options.onError ?? defaultOnError;

  function report(err: SigtakeError): false {
    try {
      onError(err);
    } catch {
      // A throwing onError must not turn a lost ping into a broken job.
    }
    return false;
  }

  async function ping(suffix: string, rid: string | undefined): Promise<boolean> {
    if (rid !== undefined && (typeof rid !== 'string' || !RID_PATTERN.test(rid))) {
      return report(
        localValidationError('rid must be 1–64 characters of letters, digits, `.`, `_`, `:` or `-`'),
      );
    }
    const url = `${base}${suffix}${rid === undefined ? '' : `?rid=${encodeURIComponent(rid)}`}`;
    try {
      const result = await sendPing(url, transport);
      return result.ok ? true : report(result.error);
    } catch (err) {
      return report(
        new SigtakeError(err instanceof Error ? err.message : 'Sigtake ping failed', { status: 0, cause: err }),
      );
    }
  }

  function failSuffix(exitCode: number | undefined): string | SigtakeError {
    if (exitCode === undefined) return '/fail';
    if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > EXIT_CODE_MAX) {
      return localValidationError('exitCode must be an integer from 1 to 255; report 0 with success()');
    }
    return `/${exitCode}`;
  }

  const success = (opts: RunOptions = {}) => ping('', opts.rid);

  const fail = (opts: FailOptions = {}) => {
    const suffix = failSuffix(opts.exitCode);
    return typeof suffix === 'string' ? ping(suffix, opts.rid) : Promise.resolve(report(suffix));
  };

  async function start(opts: RunOptions = {}): Promise<HeartbeatRun> {
    const rid = opts.rid ?? randomUUID();
    const started = await ping('/start', rid);
    return {
      rid,
      started,
      success: () => success({ rid }),
      fail: (failOpts = {}) => fail({ ...failOpts, rid }),
    };
  }

  async function wrap<T>(fn: () => T | Promise<T>, opts: RunOptions = {}): Promise<T> {
    const run = await start(opts);
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      await run.fail({ exitCode: 1 });
      throw err;
    }
    await run.success();
    return value;
  }

  return { start, success, fail, wrap };
}

/**
 * Reports to one Sigtake Heartbeat. Needs no API key: the heartbeat's token is the credential.
 * Takes the token, or the full ping URL. No method ever rejects; failed pings go to `onError`,
 * which defaults to `console.warn`.
 */
export function heartbeat(token: string, options?: HeartbeatOptions): Heartbeat {
  return createHeartbeat(token, options);
}
