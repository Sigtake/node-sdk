import { describe, expect, it } from 'vitest';
import { Sigtake } from '../src/client.js';
import {
  SigtakeAuthError,
  SigtakeServerError,
  SigtakeValidationError,
} from '../src/errors.js';
import { jsonResponse, mockFetch } from './helpers.js';

const ALERT = {
  id: '8f2a1c1e-0000-4000-8000-000000000001',
  title: 'Checkout latency above threshold',
  severity: 'high',
  status: 'firing',
  source: 'checkout-api',
  fingerprint: 'a'.repeat(64),
  occurrence_count: 1,
  last_seen_at: null,
  created_at: '2026-08-11T10:00:00.000Z',
  updated_at: '2026-08-11T10:00:00.000Z',
  resolved_at: null,
};

function makeClient(fetchImpl: ReturnType<typeof mockFetch>, maxRetries = 0) {
  return new Sigtake({
    apiKey: 'sk_test',
    baseUrl: 'http://localhost:3000',
    maxRetries,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

describe('alerts.ingest', () => {
  it('returns the alert and the dedup metadata on 201', async () => {
    const fetchImpl = mockFetch([
      jsonResponse(201, { data: ALERT, meta: { is_duplicate: false, occurrence_count: 1 } }),
    ]);

    const result = await makeClient(fetchImpl).alerts.ingest({
      title: 'Checkout latency above threshold',
      severity: 'high',
      source: 'checkout-api',
      team_code: 'OPS',
    });

    expect(result.data.id).toBe(ALERT.id);
    expect(result.meta).toEqual({ is_duplicate: false, occurrence_count: 1 });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://localhost:3000/api/ingest');
  });

  it('omits severity and payload so the server applies its own defaults', async () => {
    const fetchImpl = mockFetch([
      jsonResponse(201, { data: ALERT, meta: { is_duplicate: false, occurrence_count: 1 } }),
    ]);

    await makeClient(fetchImpl).alerts.ingest({
      title: 'Disk almost full',
      source: 'host-01',
      team_code: 'OPS',
    });

    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toEqual({ title: 'Disk almost full', source: 'host-01', team_code: 'OPS' });
  });

  it('surfaces Zod fieldErrors on a 400', async () => {
    const fetchImpl = mockFetch([
      jsonResponse(400, { message: 'Validation error', errors: { title: ['Required'] } }),
    ]);

    const error = await makeClient(fetchImpl)
      .alerts.ingest({ title: 'x', source: 'y', team_code: 'OPS' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SigtakeValidationError);
    expect((error as SigtakeValidationError).fieldErrors).toEqual({ title: ['Required'] });
  });

  it('reports an unknown team code with the server message', async () => {
    const fetchImpl = mockFetch([jsonResponse(400, { message: "Team code 'NOPE' not found" })]);

    await expect(
      makeClient(fetchImpl).alerts.ingest({ title: 'x', source: 'y', team_code: 'NOPE' }),
    ).rejects.toThrow("Team code 'NOPE' not found");
  });

  it('keeps the TEAM_NOT_IN_PROJECT code so callers can branch on it', async () => {
    const fetchImpl = mockFetch([
      jsonResponse(400, {
        message: 'Team is not assigned to this project',
        code: 'TEAM_NOT_IN_PROJECT',
      }),
    ]);

    const error = await makeClient(fetchImpl)
      .alerts.ingest({ title: 'x', source: 'y', team_code: 'OPS' })
      .catch((err: unknown) => err);

    expect((error as SigtakeValidationError).code).toBe('TEAM_NOT_IN_PROJECT');
  });

  it('maps a 401 to SigtakeAuthError', async () => {
    const fetchImpl = mockFetch([jsonResponse(401, { message: 'Invalid or disabled API key' })]);

    await expect(
      makeClient(fetchImpl).alerts.ingest({ title: 'x', source: 'y', team_code: 'OPS' }),
    ).rejects.toBeInstanceOf(SigtakeAuthError);
  });

  it('retries a 5xx and throws SigtakeServerError once the budget runs out', async () => {
    const fetchImpl = mockFetch([jsonResponse(500, { message: 'Internal server error' })]);

    await expect(
      makeClient(fetchImpl, 1).alerts.ingest({ title: 'x', source: 'y', team_code: 'OPS' }),
    ).rejects.toBeInstanceOf(SigtakeServerError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized payload without touching the network', async () => {
    const fetchImpl = mockFetch([jsonResponse(201, {})]);
    const payload = { blob: 'x'.repeat(9000) };

    await expect(
      makeClient(fetchImpl).alerts.ingest({ title: 'x', source: 'y', team_code: 'OPS', payload }),
    ).rejects.toBeInstanceOf(SigtakeValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a team_code longer than the column allows', async () => {
    const fetchImpl = mockFetch([jsonResponse(201, {})]);

    await expect(
      makeClient(fetchImpl).alerts.ingest({ title: 'x', source: 'y', team_code: 'THIRTEEN_CHAR' }),
    ).rejects.toThrow(/team_code/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
