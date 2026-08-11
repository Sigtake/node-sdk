import { describe, expect, it } from 'vitest';
import { Sigtake } from '../src/client.js';
import {
  SigtakeConflictError,
  SigtakeNotFoundError,
  SigtakeValidationError,
} from '../src/errors.js';
import { jsonResponse, mockFetch } from './helpers.js';

function makeClient(fetchImpl: ReturnType<typeof mockFetch>) {
  return new Sigtake({
    apiKey: 'sk_test',
    baseUrl: 'http://localhost:3000',
    maxRetries: 0,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

describe('signals.ingest', () => {
  it('returns the accepted count on 200', async () => {
    const fetchImpl = mockFetch([jsonResponse(200, { received: 2 })]);

    const result = await makeClient(fetchImpl).signals.ingest({
      source: 'billing-service',
      readings: [
        { metric: 'emails_sent', value: 42 },
        { metric: 'queue_depth', value: 3 },
      ],
    });

    expect(result).toEqual({ received: 2 });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://localhost:3000/api/signals/ingest');
  });

  it('resolves on a partial 422 because those readings are already stored', async () => {
    const fetchImpl = mockFetch([jsonResponse(422, { received: 1, rejected: ['new_metric'] })]);

    const result = await makeClient(fetchImpl).signals.ingest({
      source: 'billing-service',
      readings: [
        { metric: 'emails_sent', value: 1 },
        { metric: 'new_metric', value: 2 },
      ],
    });

    expect(result).toEqual({ received: 1, rejected: ['new_metric'] });
  });

  it('throws on a total 422, which carries `error` instead of `received`', async () => {
    const fetchImpl = mockFetch([
      jsonResponse(422, { error: 'Cardinality limit reached (50 metrics)', rejected: ['a', 'b'] }),
    ]);

    const error = await makeClient(fetchImpl)
      .signals.ingest({ source: 'billing-service', readings: [{ metric: 'a', value: 1 }] })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SigtakeValidationError);
    expect((error as SigtakeValidationError).status).toBe(422);
    expect((error as SigtakeValidationError).message).toContain('Cardinality limit reached');
  });

  it('maps a missing monitor to SigtakeNotFoundError', async () => {
    const fetchImpl = mockFetch([jsonResponse(404, { error: 'Monitor not found' })]);

    await expect(
      makeClient(fetchImpl).signals.ingest({ source: 'nope', readings: [{ metric: 'a', value: 1 }] }),
    ).rejects.toBeInstanceOf(SigtakeNotFoundError);
  });

  it('maps a paused monitor to SigtakeConflictError', async () => {
    const fetchImpl = mockFetch([jsonResponse(409, { error: 'Monitor is paused' })]);

    await expect(
      makeClient(fetchImpl).signals.ingest({ source: 'paused', readings: [{ metric: 'a', value: 1 }] }),
    ).rejects.toBeInstanceOf(SigtakeConflictError);
  });

  it('rejects NaN locally, since JSON would turn it into null', async () => {
    const fetchImpl = mockFetch([jsonResponse(200, { received: 1 })]);

    await expect(
      makeClient(fetchImpl).signals.ingest({
        source: 'billing-service',
        readings: [{ metric: 'ratio', value: Number.NaN }],
      }),
    ).rejects.toThrow(/finite number/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized batches locally', async () => {
    const fetchImpl = mockFetch([jsonResponse(200, { received: 1 })]);
    const client = makeClient(fetchImpl);

    await expect(client.signals.ingest({ source: 'x', readings: [] })).rejects.toBeInstanceOf(
      SigtakeValidationError,
    );
    await expect(
      client.signals.ingest({
        source: 'x',
        readings: Array.from({ length: 101 }, (_, i) => ({ metric: `m${i}`, value: i })),
      }),
    ).rejects.toThrow(/at most 100/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('signals.send', () => {
  it('flattens an object of metrics into readings', async () => {
    const fetchImpl = mockFetch([jsonResponse(200, { received: 2 })]);

    await makeClient(fetchImpl).signals.send('billing-service', { emails_sent: 42, queue_depth: 3 });

    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toEqual({
      source: 'billing-service',
      readings: [
        { metric: 'emails_sent', value: 42 },
        { metric: 'queue_depth', value: 3 },
      ],
    });
  });

  it('runs the same validation as ingest', async () => {
    const fetchImpl = mockFetch([jsonResponse(200, { received: 1 })]);

    await expect(
      makeClient(fetchImpl).signals.send('billing-service', { ratio: Number.POSITIVE_INFINITY }),
    ).rejects.toBeInstanceOf(SigtakeValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
