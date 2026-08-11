import { vi } from 'vitest';

export interface ResponseSpec {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function jsonResponse(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): ResponseSpec {
  return { status, body, headers };
}

export function buildResponse(spec: ResponseSpec): Response {
  return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
    status: spec.status,
    headers: { 'Content-Type': 'application/json', ...spec.headers },
  });
}

/**
 * Answers each call with the next queued spec, repeating the last one.
 * A fresh Response per call, never `clone()` — cloning tees the body, and
 * cancelling one branch of a tee whose sibling is never read can hang.
 */
export function mockFetch(specs: ResponseSpec[]) {
  let index = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const spec = specs[Math.min(index, specs.length - 1)]!;
    index++;
    return buildResponse(spec);
  });
}

/** A fetch that never settles until its signal aborts. */
export function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
}
