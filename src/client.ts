import { HttpClient } from './http.js';
import { AlertsResource } from './resources/alerts.js';
import { SignalsResource } from './resources/signals.js';
import type { SigtakeOptions } from './types.js';

const DEFAULT_BASE_URL = 'https://api.sigtake.com';
const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_RETRIES = 3;

export class Sigtake {
  readonly alerts: AlertsResource;
  readonly signals: SignalsResource;

  constructor(options: SigtakeOptions) {
    if (!options?.apiKey || typeof options.apiKey !== 'string') {
      throw new TypeError('Sigtake: `apiKey` is required. Create one in Settings → API Keys.');
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError(
        'Sigtake: global fetch is unavailable. Use Node 18 or newer, or pass `fetch` explicitly.',
      );
    }

    const http = new HttpClient({
      apiKey: options.apiKey,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      headers: options.headers ?? {},
      fetch: fetchImpl,
    });

    this.alerts = new AlertsResource(http);
    this.signals = new SignalsResource(http);
  }
}
