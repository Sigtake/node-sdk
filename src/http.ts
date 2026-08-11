import { SigtakeNetworkError, errorFromResponse } from './errors.js';
import type { RequestOptions } from './types.js';

export interface HttpClientConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  headers: Record<string, string>;
  fetch: typeof globalThis.fetch;
  /** Base of the exponential backoff, in ms. Exposed so tests need not sleep for seconds. */
  retryBaseDelay?: number;
  retryMaxDelay?: number;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  retryAfter: number | undefined;
}

const DEFAULT_RETRY_BASE_DELAY = 500;
const DEFAULT_RETRY_MAX_DELAY = 30_000;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A proxy or load balancer can answer HTML on 5xx; keep it rather than lose it.
    return text;
  }
}

interface CombinedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function combineSignals(timeoutSignal: AbortSignal, userSignal?: AbortSignal): CombinedSignal {
  if (!userSignal) return { signal: timeoutSignal, cleanup: () => {} };

  const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') {
    return { signal: anyOf.call(AbortSignal, [timeoutSignal, userSignal]), cleanup: () => {} };
  }

  // Node 18 has no AbortSignal.any.
  const controller = new AbortController();
  const abort = (reason: unknown) => controller.abort(reason);
  const onTimeout = () => abort(timeoutSignal.reason);
  const onUser = () => abort(userSignal.reason);

  if (timeoutSignal.aborted) abort(timeoutSignal.reason);
  else if (userSignal.aborted) abort(userSignal.reason);
  else {
    timeoutSignal.addEventListener('abort', onTimeout, { once: true });
    userSignal.addEventListener('abort', onUser, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      timeoutSignal.removeEventListener('abort', onTimeout);
      userSignal.removeEventListener('abort', onUser);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class HttpClient {
  private readonly config: Required<HttpClientConfig>;

  constructor(config: HttpClientConfig) {
    this.config = {
      ...config,
      retryBaseDelay: config.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY,
      retryMaxDelay: config.retryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY,
    };
  }

  /** Equal jitter: half the exponential window is fixed, half is random. */
  private backoffDelay(attempt: number, retryAfter: number | undefined): number {
    if (retryAfter !== undefined) {
      return Math.min(retryAfter * 1000, this.config.retryMaxDelay);
    }
    const window = Math.min(this.config.retryBaseDelay * 2 ** attempt, this.config.retryMaxDelay);
    return window / 2 + Math.random() * (window / 2);
  }

  async post(path: string, payload: unknown, options: RequestOptions = {}): Promise<ApiResponse> {
    const url = `${this.config.baseUrl}${path}`;
    const timeout = options.timeout ?? this.config.timeout;
    const body = JSON.stringify(payload);
    let lastNetworkError: SigtakeNetworkError | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const { signal, cleanup } = combineSignals(timeoutSignal, options.signal);

      let response: Response;
      try {
        response = await this.config.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Api-Key': this.config.apiKey,
            ...this.config.headers,
          },
          body,
          signal,
        });
      } catch (err) {
        // A caller-initiated abort is an instruction, not a failure to retry around.
        if (options.signal?.aborted) throw err;

        lastNetworkError = timeoutSignal.aborted
          ? new SigtakeNetworkError(`Sigtake request timed out after ${timeout}ms`, {
              status: 0,
              cause: err,
            })
          : new SigtakeNetworkError(
              err instanceof Error ? err.message : 'Sigtake request failed',
              { status: 0, cause: err },
            );

        if (attempt === this.config.maxRetries) throw lastNetworkError;
        await sleep(this.backoffDelay(attempt, undefined), options.signal);
        continue;
      } finally {
        cleanup();
      }

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));

      if (isRetryableStatus(response.status) && attempt < this.config.maxRetries) {
        // Drained rather than cancelled: an unread body holds the socket, and
        // cancelling one throws ERR_INVALID_STATE on Node 18's undici.
        await response.text().catch(() => undefined);
        await sleep(this.backoffDelay(attempt, retryAfter), options.signal);
        continue;
      }

      return { status: response.status, body: await parseBody(response), retryAfter };
    }

    /* c8 ignore next */
    throw lastNetworkError ?? new SigtakeNetworkError('Sigtake request failed', { status: 0 });
  }
}

/** Throws the mapped error class unless the response is 2xx. */
export function ensureOk(response: ApiResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  throw errorFromResponse(response.status, response.body, { retryAfter: response.retryAfter });
}
