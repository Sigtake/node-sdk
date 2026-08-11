import { describe, expect, it, vi } from 'vitest';
import { HttpClient, ensureOk } from '../src/http.js';
import { SigtakeNetworkError, SigtakeValidationError } from '../src/errors.js';
import { buildResponse, hangingFetch, jsonResponse, mockFetch } from './helpers.js';

function client(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<{
    maxRetries: number;
    retryBaseDelay: number;
    retryMaxDelay: number;
    timeout: number;
  }> = {},
) {
  return new HttpClient({
    apiKey: 'sk_test',
    baseUrl: 'http://localhost:3000',
    timeout: overrides.timeout ?? 1000,
    maxRetries: overrides.maxRetries ?? 3,
    headers: {},
    fetch: fetchImpl,
    retryBaseDelay: overrides.retryBaseDelay ?? 5,
    retryMaxDelay: overrides.retryMaxDelay ?? 50,
  });
}

describe('HttpClient', () => {
  it('sends the API key and a JSON body to the resolved URL', async () => {
    const fetchImpl = mockFetch([jsonResponse(200, { received: 1 })]);
    await client(fetchImpl as unknown as typeof globalThis.fetch).post('/api/signals/ingest', {
      source: 'billing',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/api/signals/ingest');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      'X-Api-Key': 'sk_test',
      'Content-Type': 'application/json',
    });
    expect((init as RequestInit).body).toBe(JSON.stringify({ source: 'billing' }));
  });

  it('retries a 500 and returns the eventual success', async () => {
    const fetchImpl = mockFetch([jsonResponse(500, { message: 'boom' }), jsonResponse(200, { received: 2 })]);
    const response = await client(fetchImpl as unknown as typeof globalThis.fetch).post('/api/signals/ingest', {});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: 2 });
  });

  it('gives up after maxRetries + 1 attempts', async () => {
    const fetchImpl = mockFetch([jsonResponse(429, { message: 'API key rate limit exceeded' })]);
    const response = await client(fetchImpl as unknown as typeof globalThis.fetch, { maxRetries: 2 }).post('/api/ingest', {});

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(response.status).toBe(429);
  });

  it('never retries a 4xx that is not 408 or 429', async () => {
    const fetchImpl = mockFetch([jsonResponse(400, { message: 'Validation error' })]);
    const response = await client(fetchImpl as unknown as typeof globalThis.fetch).post('/api/ingest', {});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
  });

  it('backs off with growing, jittered delays', async () => {
    const delays: number[] = [];
    let previous = Date.now();
    const fetchImpl = vi.fn(async () => {
      const now = Date.now();
      delays.push(now - previous);
      previous = now;
      return buildResponse(jsonResponse(503, { message: 'unavailable' }));
    });

    await client(fetchImpl as unknown as typeof globalThis.fetch, {
      maxRetries: 3,
      retryBaseDelay: 40,
      retryMaxDelay: 5000,
    }).post('/api/ingest', {});

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // Windows double (40/80/160 ms) and equal jitter puts each gap in [w/2, w].
    // Only the lower bound is asserted: a timer may overshoot, never undershoot,
    // and the jitter draw itself is deliberately non-deterministic.
    expect(delays[1]).toBeGreaterThanOrEqual(20);
    expect(delays[2]).toBeGreaterThanOrEqual(40);
    expect(delays[3]).toBeGreaterThanOrEqual(80);
  });

  it('prefers Retry-After over the exponential window when present', async () => {
    const fetchImpl = mockFetch([
      jsonResponse(429, { message: 'slow down' }, { 'Retry-After': '0' }),
      jsonResponse(200, { received: 1 }),
    ]);
    const started = Date.now();
    await client(fetchImpl as unknown as typeof globalThis.fetch, { retryBaseDelay: 5000 }).post('/api/ingest', {});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('retries network failures and finally throws SigtakeNetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(
      client(fetchImpl as unknown as typeof globalThis.fetch, { maxRetries: 1 }).post('/api/ingest', {}),
    ).rejects.toBeInstanceOf(SigtakeNetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('turns the per-attempt timeout into SigtakeNetworkError instead of hanging', async () => {
    const fetchImpl = hangingFetch();

    const error = await client(fetchImpl as unknown as typeof globalThis.fetch, {
      maxRetries: 0,
      timeout: 20,
    })
      .post('/api/ingest', {})
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SigtakeNetworkError);
    expect((error as SigtakeNetworkError).message).toContain('timed out');
    expect((error as SigtakeNetworkError).status).toBe(0);
  });

  it('composes the caller signal without AbortSignal.any, as on Node 18', async () => {
    const anyOf = (AbortSignal as unknown as Record<string, unknown>)['any'];
    delete (AbortSignal as unknown as Record<string, unknown>)['any'];
    try {
      const fetchImpl = hangingFetch();
      const controller = new AbortController();
      const promise = client(fetchImpl as unknown as typeof globalThis.fetch, {
        maxRetries: 0,
      }).post('/api/ingest', {}, { signal: controller.signal });
      controller.abort(new Error('aborted on the fallback path'));

      await expect(promise).rejects.toThrow('aborted on the fallback path');
    } finally {
      (AbortSignal as unknown as Record<string, unknown>)['any'] = anyOf;
    }
  });

  it('propagates a caller abort without retrying', async () => {
    const fetchImpl = hangingFetch();
    const controller = new AbortController();
    const promise = client(fetchImpl as unknown as typeof globalThis.fetch).post('/api/ingest', {}, {
      signal: controller.signal,
    });
    controller.abort(new Error('caller changed its mind'));

    await expect(promise).rejects.toThrow('caller changed its mind');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('ensureOk', () => {
  it('passes 2xx through and throws the mapped class otherwise', () => {
    expect(() => ensureOk({ status: 201, body: {}, retryAfter: undefined })).not.toThrow();
    expect(() => ensureOk({ status: 400, body: { message: 'bad' }, retryAfter: undefined })).toThrow(
      SigtakeValidationError,
    );
  });
});
