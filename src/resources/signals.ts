import { localValidationError } from '../errors.js';
import { ensureOk, type HttpClient } from '../http.js';
import type {
  IngestSignalsInput,
  IngestSignalsResponse,
  RequestOptions,
  SignalReading,
} from '../types.js';

const MAX_READINGS = 100;

export class SignalsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Sends a batch of readings to `POST /api/signals/ingest`.
   *
   * A monitor capped at 50 distinct metric names answers 422. When at least one
   * reading was stored the call **resolves** with `{ received, rejected }` — those
   * rows are already persisted, so surfacing it as a throw would force a
   * try/catch around a successful write. Only a total rejection throws.
   */
  async ingest(
    input: IngestSignalsInput,
    options?: RequestOptions,
  ): Promise<IngestSignalsResponse> {
    validateSignals(input);

    const response = await this.http.post(
      '/api/signals/ingest',
      { source: input.source, readings: input.readings },
      options ?? {},
    );

    const partial = asPartialDelivery(response.status, response.body);
    if (partial) return partial;

    ensureOk(response);
    return response.body as IngestSignalsResponse;
  }

  /**
   * `ingest()` for the common shape: a flat object of metric → value.
   *
   * ```ts
   * await client.signals.send('billing-service', { emails_sent: 42, queue_depth: 3 });
   * ```
   */
  async send(
    source: string,
    metrics: Record<string, number>,
    options?: RequestOptions,
  ): Promise<IngestSignalsResponse> {
    if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
      throw localValidationError('metrics must be a plain object of metric name to number');
    }
    const readings: SignalReading[] = Object.entries(metrics).map(([metric, value]) => ({
      metric,
      value,
    }));
    return this.ingest({ source, readings }, options);
  }
}

/** 422 carries two different bodies; only the one with `received` is a partial success. */
function asPartialDelivery(status: number, body: unknown): IngestSignalsResponse | undefined {
  if (status !== 422 || typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record['received'] !== 'number') return undefined;
  return {
    received: record['received'],
    ...(Array.isArray(record['rejected']) ? { rejected: record['rejected'] as string[] } : {}),
  };
}

function validateSignals(input: IngestSignalsInput): void {
  if (typeof input?.source !== 'string' || input.source.length < 1 || input.source.length > 200) {
    throw localValidationError('source must be a string between 1 and 200 characters');
  }
  if (!Array.isArray(input.readings) || input.readings.length === 0) {
    throw localValidationError('readings must be a non-empty array');
  }
  if (input.readings.length > MAX_READINGS) {
    throw localValidationError(`readings must contain at most ${MAX_READINGS} elements`);
  }
  for (const reading of input.readings) {
    if (
      typeof reading?.metric !== 'string' ||
      reading.metric.length < 1 ||
      reading.metric.length > 100
    ) {
      throw localValidationError('each reading needs a metric of 1 to 100 characters');
    }
    // JSON.stringify turns NaN and Infinity into null, so the server would reject
    // a payload that no longer contains the value the caller actually sent.
    if (typeof reading.value !== 'number' || !Number.isFinite(reading.value)) {
      throw localValidationError(
        `reading "${reading.metric}" must have a finite number value, received ${String(reading?.value)}`,
      );
    }
  }
}
