import { describe, expect, it } from 'vitest';
import {
  SigtakeAuthError,
  SigtakeConflictError,
  SigtakeError,
  SigtakeNotFoundError,
  SigtakeRateLimitError,
  SigtakeServerError,
  SigtakeValidationError,
  errorFromResponse,
} from '../src/errors.js';

describe('errorFromResponse', () => {
  it('maps each status to its class', () => {
    expect(errorFromResponse(401, { message: 'Invalid or disabled API key' })).toBeInstanceOf(SigtakeAuthError);
    expect(errorFromResponse(404, { error: 'Monitor not found' })).toBeInstanceOf(SigtakeNotFoundError);
    expect(errorFromResponse(409, { error: 'Monitor is paused' })).toBeInstanceOf(SigtakeConflictError);
    expect(errorFromResponse(429, { message: 'API key rate limit exceeded' })).toBeInstanceOf(SigtakeRateLimitError);
    expect(errorFromResponse(500, { message: 'Internal server error' })).toBeInstanceOf(SigtakeServerError);
    expect(errorFromResponse(400, { message: 'Validation error' })).toBeInstanceOf(SigtakeValidationError);
    expect(errorFromResponse(422, { error: 'Cardinality limit reached' })).toBeInstanceOf(SigtakeValidationError);
  });

  it('reads the message from `message` or from `error`', () => {
    // /api/ingest answers { message }, /api/signals/ingest answers { error }.
    expect(errorFromResponse(400, { message: "Team code 'OPS' not found" }).message).toBe(
      "Team code 'OPS' not found",
    );
    expect(errorFromResponse(409, { error: 'Monitor is paused' }).message).toBe('Monitor is paused');
  });

  it('falls back to a status-bearing message for bodies with neither key', () => {
    expect(errorFromResponse(502, '<html>bad gateway</html>').message).toContain('502');
    expect(errorFromResponse(502, undefined).body).toBeUndefined();
  });

  it('exposes fieldErrors only when the body carries Zod output', () => {
    const withFields = errorFromResponse(400, {
      message: 'Validation error',
      errors: { title: ['String must contain at least 1 character(s)'] },
    }) as SigtakeValidationError;
    expect(withFields.fieldErrors).toEqual({ title: ['String must contain at least 1 character(s)'] });

    const withoutFields = errorFromResponse(422, { error: 'Cardinality limit reached', rejected: ['x'] }) as SigtakeValidationError;
    expect(withoutFields.fieldErrors).toBeUndefined();
    expect(withoutFields.status).toBe(422);
  });

  it('keeps `code` when the global handler forwards one', () => {
    const err = errorFromResponse(400, {
      message: 'Team is not assigned to this project',
      code: 'TEAM_NOT_IN_PROJECT',
    });
    expect(err.code).toBe('TEAM_NOT_IN_PROJECT');
  });

  it('carries Retry-After on rate limit errors', () => {
    const err = errorFromResponse(429, { message: 'slow down' }, { retryAfter: 12 }) as SigtakeRateLimitError;
    expect(err.retryAfter).toBe(12);
  });

  it('keeps the raw body and a usable name for every subclass', () => {
    const body = { error: 'Monitor not found' };
    const err = errorFromResponse(404, body);
    expect(err.body).toBe(body);
    expect(err.name).toBe('SigtakeNotFoundError');
    expect(err).toBeInstanceOf(SigtakeError);
    expect(err).toBeInstanceOf(Error);
  });

  it('falls back to the base class for an unmapped status', () => {
    const err = errorFromResponse(418, { message: "I'm a teapot" });
    expect(err.constructor).toBe(SigtakeError);
  });
});
