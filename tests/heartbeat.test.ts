import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sigtake, heartbeat } from '../src/index.js';
import { createHeartbeat } from '../src/heartbeat/index.js';
import {
  SigtakeError,
  SigtakeNetworkError,
  SigtakeNotFoundError,
  SigtakeRateLimitError,
  SigtakeServerError,
  SigtakeValidationError,
} from '../src/errors.js';
import { hangingFetch, mockFetch, type ResponseSpec } from './helpers.js';
import type { HeartbeatOptions } from '../src/types.js';

const PING_URL = 'https://api.sigtake.com/ping/abcDEF123_-xyz';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function text(status: number, body = '', headers: Record<string, string> = {}): ResponseSpec {
  return { status, body: body === '' ? undefined : body, headers };
}

const ok = text(204);

function textFetch(specs: ResponseSpec[]) {
  let index = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const spec = specs[Math.min(index, specs.length - 1)]!;
    index++;
    return new Response(spec.body === undefined ? null : String(spec.body), {
      status: spec.status,
      headers: { 'Content-Type': 'text/plain', ...spec.headers },
    });
  });
}

function hb(fetchImpl: unknown, options: Omit<HeartbeatOptions, 'fetch'> = {}) {
  return createHeartbeat(
    PING_URL,
    { onError: () => {}, ...options, fetch: fetchImpl as typeof globalThis.fetch },
    { retryBaseDelay: 1 },
  );
}

function urlOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): URL {
  return new URL(fetchImpl.mock.calls[call]![0] as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('heartbeat URL', () => {
  it.each([
    ['', 'required'],
    ['not a token', '`token` is not valid'],
    ['abc.def', '`token` is not valid'],
    ['https//:', 'not a valid URL'],
    ['ftp://api.sigtake.com/ping/abc', 'http(s)'],
    ['https://api.sigtake.com/ping/abc?x=1', 'query'],
    ['https://api.sigtake.com/ping/abc#x', 'query'],
    ['https://api.sigtake.com/api/ingest', '/ping/<token>'],
    ['https://api.sigtake.com/ping/', '/ping/<token>'],
    ['https://api.sigtake.com/ping/abc/start', '/ping/<token>'],
  ])('rejects %j', (url, message) => {
    expect(() => heartbeat(url)).toThrow(TypeError);
    expect(() => heartbeat(url)).toThrow(message);
  });

  it('accepts a trailing slash', async () => {
    const fetchImpl = textFetch([ok]);
    const beat = createHeartbeat(`${PING_URL}/`, { fetch: fetchImpl as unknown as typeof fetch });
    await beat.success();
    expect(fetchImpl.mock.calls[0]![0]).toBe(PING_URL);
  });
});

describe('heartbeat token', () => {
  const TOKEN = 'abcDEF123_-xyz';

  it('sends the token to the default host', async () => {
    const fetchImpl = textFetch([ok, ok, ok]);
    const beat = createHeartbeat(TOKEN, { fetch: fetchImpl as unknown as typeof fetch });
    await beat.success();
    await beat.fail({ exitCode: 3 });
    const run = await beat.start();

    expect(fetchImpl.mock.calls[0]![0]).toBe(PING_URL);
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${PING_URL}/3`);
    expect(fetchImpl.mock.calls[2]![0]).toBe(`${PING_URL}/start?rid=${run.rid}`);
  });

  it('trims the token and uses a custom baseUrl', async () => {
    const fetchImpl = textFetch([ok]);
    const beat = createHeartbeat(` ${TOKEN} `, {
      baseUrl: 'http://localhost:3000/',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await beat.success();
    expect(fetchImpl.mock.calls[0]![0]).toBe(`http://localhost:3000/ping/${TOKEN}`);
  });

  it('ignores baseUrl when given a full ping URL', async () => {
    const fetchImpl = textFetch([ok]);
    const beat = createHeartbeat(PING_URL, {
      baseUrl: 'http://localhost:3000',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await beat.success();
    expect(fetchImpl.mock.calls[0]![0]).toBe(PING_URL);
  });
});

describe('heartbeat pings', () => {
  it('posts a success without a body, API key or rid', async () => {
    const fetchImpl = textFetch([ok]);
    await expect(hb(fetchImpl).success()).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(PING_URL);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });

  it('routes fail to /fail and an exit code to /<n>', async () => {
    const fetchImpl = textFetch([ok]);
    const beat = hb(fetchImpl);
    await beat.fail();
    await beat.fail({ exitCode: 3, rid: 'job-7' });

    expect(urlOf(fetchImpl, 0).pathname).toBe('/ping/abcDEF123_-xyz/fail');
    expect(urlOf(fetchImpl, 1).pathname).toBe('/ping/abcDEF123_-xyz/3');
    expect(urlOf(fetchImpl, 1).searchParams.get('rid')).toBe('job-7');
  });

  it('start generates a UUID rid and the run reuses it', async () => {
    const fetchImpl = textFetch([ok]);
    const run = await hb(fetchImpl).start();
    await run.success();

    expect(run.rid).toMatch(UUID);
    expect(run.started).toBe(true);
    expect(urlOf(fetchImpl, 0).pathname).toBe('/ping/abcDEF123_-xyz/start');
    expect(urlOf(fetchImpl, 0).searchParams.get('rid')).toBe(run.rid);
    expect(urlOf(fetchImpl, 1).pathname).toBe('/ping/abcDEF123_-xyz');
    expect(urlOf(fetchImpl, 1).searchParams.get('rid')).toBe(run.rid);
  });

  it('keeps a custom rid across the run', async () => {
    const fetchImpl = textFetch([ok]);
    const run = await hb(fetchImpl).start({ rid: 'lead-4821:attempt.2' });
    await run.fail({ exitCode: 2 });

    expect(run.rid).toBe('lead-4821:attempt.2');
    expect(urlOf(fetchImpl, 1).pathname).toBe('/ping/abcDEF123_-xyz/2');
    expect(urlOf(fetchImpl, 1).searchParams.get('rid')).toBe('lead-4821:attempt.2');
  });

  it.each(['a b', 'x'.repeat(65), '', 'lead/1', 'café'])(
    'reports the invalid rid %j locally and sends nothing',
    async (rid) => {
      const fetchImpl = textFetch([ok]);
      const onError = vi.fn();
      const run = await hb(fetchImpl, { onError }).start({ rid });

      expect(run.started).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
      const err = onError.mock.calls[0]![0];
      expect(err).toBeInstanceOf(SigtakeValidationError);
      expect(err.status).toBe(0);
    },
  );

  it.each([0, 256, -1, 1.5, Number.NaN])('rejects exit code %s locally', async (exitCode) => {
    const fetchImpl = textFetch([ok]);
    const onError = vi.fn();
    await expect(hb(fetchImpl, { onError }).fail({ exitCode })).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(SigtakeValidationError);
  });

  it('accepts exit codes 1 and 255', async () => {
    const fetchImpl = textFetch([ok]);
    const beat = hb(fetchImpl);
    await beat.fail({ exitCode: 1 });
    await beat.fail({ exitCode: 255 });
    expect(urlOf(fetchImpl, 0).pathname).toBe('/ping/abcDEF123_-xyz/1');
    expect(urlOf(fetchImpl, 1).pathname).toBe('/ping/abcDEF123_-xyz/255');
  });
});

describe('heartbeat errors and retries', () => {
  it('retries network errors and resolves once delivered', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed');
      return new Response(null, { status: 204 });
    });
    await expect(hb(fetchImpl).success()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a 503 and gives up after maxRetries', async () => {
    const fetchImpl = textFetch([text(503, 'Temporarily unavailable. Try again.')]);
    const onError = vi.fn();
    await expect(hb(fetchImpl, { onError }).success()).resolves.toBe(false);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(SigtakeServerError);
    expect(err.message).toBe('Temporarily unavailable. Try again.');
  });

  it('honours maxRetries: 0', async () => {
    const fetchImpl = textFetch([text(503)]);
    await hb(fetchImpl, { maxRetries: 0 }).success();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, SigtakeNotFoundError, 'Ping token not found. Check the URL or rotate the token in Sigtake.'],
    [400, SigtakeValidationError, 'Invalid rid.'],
    [429, SigtakeRateLimitError, 'Too many pings for this check.'],
  ])('does not retry a %i', async (status, ErrorClass, message) => {
    const fetchImpl = textFetch([text(status, message, status === 429 ? { 'Retry-After': '60' } : {})]);
    const onError = vi.fn();
    await expect(hb(fetchImpl, { onError }).success()).resolves.toBe(false);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(ErrorClass);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
    if (status === 429) expect(err.retryAfter).toBe(60);
  });

  it('times out a hanging request as a network error', async () => {
    const fetchImpl = hangingFetch();
    const onError = vi.fn();
    await expect(hb(fetchImpl, { onError, timeout: 20, maxRetries: 0 }).success()).resolves.toBe(false);

    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(SigtakeNetworkError);
    expect(err.message).toContain('timed out after 20ms');
  });

  it('never rejects, even when onError throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const beat = hb(fetchImpl, {
      maxRetries: 0,
      onError: () => {
        throw new Error('handler broke');
      },
    });
    await expect(beat.success()).resolves.toBe(false);
    await expect(beat.start()).resolves.toMatchObject({ started: false });
  });

  it('warns on the console by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = textFetch([text(404, 'Ping token not found.')]);
    const beat = createHeartbeat(PING_URL, { fetch: fetchImpl as unknown as typeof fetch });
    await beat.success();

    expect(warn).toHaveBeenCalledWith('[sigtake] heartbeat ping failed: Ping token not found.');
  });

  it('falls back to a generic message on an empty error body', async () => {
    const fetchImpl = textFetch([text(418)]);
    const onError = vi.fn();
    await hb(fetchImpl, { onError }).success();

    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(SigtakeError);
    expect(err.message).toBe('Sigtake ping failed with status 418');
  });
});

describe('heartbeat wrap', () => {
  it('returns the value and reports start then success', async () => {
    const fetchImpl = textFetch([ok]);
    await expect(hb(fetchImpl).wrap(async () => 42)).resolves.toBe(42);

    expect(urlOf(fetchImpl, 0).pathname).toBe('/ping/abcDEF123_-xyz/start');
    expect(urlOf(fetchImpl, 1).pathname).toBe('/ping/abcDEF123_-xyz');
    expect(urlOf(fetchImpl, 1).searchParams.get('rid')).toBe(
      urlOf(fetchImpl, 0).searchParams.get('rid'),
    );
  });

  it('reports exit code 1 and rethrows the same error', async () => {
    const fetchImpl = textFetch([ok]);
    const boom = new Error('job failed');
    await expect(
      hb(fetchImpl).wrap(() => {
        throw boom;
      }, { rid: 'lead-1' }),
    ).rejects.toBe(boom);

    expect(urlOf(fetchImpl, 1).pathname).toBe('/ping/abcDEF123_-xyz/1');
    expect(urlOf(fetchImpl, 1).searchParams.get('rid')).toBe('lead-1');
  });

  it('runs the job even when the start ping fails', async () => {
    const fetchImpl = textFetch([text(503), text(503), text(503), ok]);
    const job = vi.fn(async () => 'done');
    await expect(hb(fetchImpl).wrap(job)).resolves.toBe('done');
    expect(job).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('waits for the closing ping before resolving', async () => {
    let release!: () => void;
    let closed = false;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 2) {
        await new Promise<void>((resolve) => (release = resolve));
        closed = true;
      }
      return new Response(null, { status: 204 });
    });

    const wrapped = hb(fetchImpl).wrap(() => 'x');
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(closed).toBe(false);
    release();
    await wrapped;
    expect(closed).toBe(true);
  });

  it('gives concurrent runs distinct rids', async () => {
    const fetchImpl = textFetch([ok]);
    const beat = hb(fetchImpl);
    await Promise.all([beat.wrap(() => 1), beat.wrap(() => 2)]);

    const rids = new Set(
      fetchImpl.mock.calls.map(([url]) => new URL(url as string).searchParams.get('rid')),
    );
    expect(rids.size).toBe(2);
  });
});

describe('Sigtake#heartbeat', () => {
  it("uses the client's fetch and never its API key or headers", async () => {
    const fetchImpl = mockFetch([{ status: 204 }]);
    const sigtake = new Sigtake({
      apiKey: 'sk_secret',
      headers: { Authorization: 'Bearer secret' },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(sigtake.heartbeat(PING_URL).success()).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(PING_URL);
    expect(init?.headers).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain('secret');
  });

  it('lets the heartbeat options override the client fetch', async () => {
    const clientFetch = mockFetch([{ status: 204 }]);
    const ownFetch = mockFetch([{ status: 204 }]);
    const sigtake = new Sigtake({ apiKey: 'sk_x', fetch: clientFetch as unknown as typeof fetch });
    await sigtake.heartbeat(PING_URL, { fetch: ownFetch as unknown as typeof fetch }).success();

    expect(ownFetch).toHaveBeenCalledOnce();
    expect(clientFetch).not.toHaveBeenCalled();
  });

  it("sends a token to the client's baseUrl", async () => {
    const fetchImpl = mockFetch([{ status: 204 }]);
    const sigtake = new Sigtake({
      apiKey: 'sk_x',
      baseUrl: 'https://staging.example.com/',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await sigtake.heartbeat('abcDEF123_-xyz').success();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://staging.example.com/ping/abcDEF123_-xyz');
  });

  it('still requires the API key on the client', () => {
    expect(() => new Sigtake({} as never)).toThrow('`apiKey` is required');
  });
});
