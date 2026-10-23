import { SigtakeError, SigtakeNetworkError, errorFromResponse } from '../errors.js';
import { parseRetryAfter } from '../http.js';

export interface PingTransportConfig {
  timeout: number;
  maxRetries: number;
  fetch: typeof globalThis.fetch;
  /** Base of the backoff, in ms. Exposed so tests need not sleep. */
  retryBaseDelay: number;
}

export type PingResult = { ok: true } | { ok: false; error: SigtakeError };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one ping. Retries network errors and 5xx only: a 429's Retry-After can reach 60 s,
 * longer than a job should wait, and 400/404 will not change on a second try.
 */
export async function sendPing(url: string, config: PingTransportConfig): Promise<PingResult> {
  let lastError: SigtakeError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      const window = config.retryBaseDelay * 2 ** (attempt - 1);
      await sleep(window / 2 + Math.random() * (window / 2));
    }

    const timeoutSignal = AbortSignal.timeout(config.timeout);
    let response: Response;
    try {
      response = await config.fetch(url, { method: 'POST', signal: timeoutSignal });
    } catch (err) {
      lastError = timeoutSignal.aborted
        ? new SigtakeNetworkError(`Sigtake ping timed out after ${config.timeout}ms`, {
            status: 0,
            cause: err,
          })
        : new SigtakeNetworkError(err instanceof Error ? err.message : 'Sigtake ping failed', {
            status: 0,
            cause: err,
          });
      continue;
    }

    const text = await response.text().catch(() => '');
    if (response.status >= 200 && response.status < 300) return { ok: true };

    lastError = errorFromResponse(
      response.status,
      { message: text.trim() || `Sigtake ping failed with status ${response.status}` },
      { retryAfter: parseRetryAfter(response.headers.get('retry-after')) },
    );
    if (response.status < 500) break;
  }

  return {
    ok: false,
    error: lastError ?? new SigtakeNetworkError('Sigtake ping failed', { status: 0 }),
  };
}
