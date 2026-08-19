export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AlertStatus = 'firing' | 'acknowledged' | 'resolved';

export interface SigtakeOptions {
  /** Ingestion API key (`sk_...`). It resolves both the tenant and the project. */
  apiKey: string;
  /** Defaults to `https://api.sigtake.com`. A trailing slash is fine. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Defaults to 10000. */
  timeout?: number;
  /** Retries after the first attempt, on 408/429/5xx/network. Defaults to 3, 0 disables. */
  maxRetries?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Override the global `fetch`, mainly for testing or custom agents. */
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  /** Aborts the request. Composed with the SDK's own timeout signal. */
  signal?: AbortSignal;
  /** Overrides the client timeout for this call only. */
  timeout?: number;
}

export interface IngestAlertInput {
  title: string;
  /** Defaults to `info` server-side. */
  severity?: Severity;
  source: string;
  /** Must serialize to 8 KB or less. */
  payload?: Record<string, unknown>;
  /** Must exist in the tenant AND be assigned to the project this API key belongs to. */
  team_code: string;
}

/**
 * Tenant, project, team and API key ids are deliberately omitted: the caller
 * already knows which key it sent the alert with.
 *
 * `payload` is not returned either. On a dedup hit the server answers with the
 * pre-existing alert, whose payload may belong to a different sender.
 */
export interface Alert {
  id: string;
  title: string;
  severity: Severity;
  status: AlertStatus;
  source: string;
  fingerprint: string;
  occurrence_count: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface IngestAlertResponse {
  data: Alert;
  meta: {
    is_duplicate: boolean;
    occurrence_count: number;
  };
}

export interface SignalReading {
  metric: string;
  value: number;
}

export interface IngestSignalsInput {
  /** The monitor's `source_key`, unique per project. */
  source: string;
  readings: SignalReading[];
}

export interface IngestSignalsResponse {
  received: number;
  /**
   * Metric names dropped because the monitor hit its 50-metric cardinality cap.
   * Present only on partial delivery, which resolves rather than throws.
   */
  rejected?: string[];
}
