import type { SigtakeError } from './errors.js';

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

export interface HeartbeatOptions {
  /** Per-attempt timeout in milliseconds. Defaults to 5000. */
  timeout?: number;
  /** Retries after the first attempt, on network errors and 5xx only. Defaults to 2, 0 disables. */
  maxRetries?: number;
  /** Receives every failed ping. Defaults to `console.warn`; pass `() => {}` to silence. */
  onError?: (err: SigtakeError) => void;
  /** Override the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface RunOptions {
  /**
   * Run id, honoured on on demand checks only. 1–64 characters of letters, digits, `.`, `_`, `:`, `-`.
   * Must be unique while the run is open, and is shown in the check's history: no emails or secrets.
   */
  rid?: string;
}

export interface FailOptions extends RunOptions {
  /** 1–255. Without it the failure is reported with no exit code. */
  exitCode?: number;
}

export interface HeartbeatRun {
  readonly rid: string;
  /** Whether the start ping was delivered. */
  readonly started: boolean;
  success(): Promise<boolean>;
  fail(options?: { exitCode?: number }): Promise<boolean>;
}

export interface Heartbeat {
  /** Opens a run. Without `rid`, a random UUID is used. */
  start(options?: RunOptions): Promise<HeartbeatRun>;
  /** Resolves `true` when the ping was delivered; never rejects. */
  success(options?: RunOptions): Promise<boolean>;
  /** Resolves `true` when the ping was delivered; never rejects. */
  fail(options?: FailOptions): Promise<boolean>;
  /**
   * Runs `fn` between a start and its result: success, or a failure with exit code 1 and the error
   * rethrown as is. Waits for every ping before resolving.
   */
  wrap<T>(fn: () => T | Promise<T>, options?: RunOptions): Promise<T>;
}

export interface RequestOptions {
  /** Aborts the request. Composed with the SDK's own timeout signal. */
  signal?: AbortSignal;
  /** Overrides the client timeout for this call only. */
  timeout?: number;
}

export interface AlertLink {
  /** 1–80 characters, shown as the link text. */
  label: string;
  /** http(s) only, up to 1024 characters, no `user:pass@`. */
  url: string;
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
  /**
   * Up to 5 reference links (runbook, dashboard, logs). On a dedup hit they are
   * merged into the open alert's links, never replacing them.
   */
  links?: AlertLink[];
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
