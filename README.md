# @sigtake/sdk

Official Node.js SDK for [Sigtake](https://sigtake.com). Sends alerts and signal
readings. Zero dependencies, ESM + CJS, typed.

```bash
npm install @sigtake/sdk
```

Requires Node 18 or newer.

## Quickstart

```ts
import { Sigtake } from '@sigtake/sdk';

const sigtake = new Sigtake({ apiKey: process.env.SIGTAKE_API_KEY! });

await sigtake.alerts.ingest({
  title: 'Checkout latency above threshold',
  severity: 'high',
  source: 'checkout-api',
  team_code: 'OPS',
  payload: { p95_ms: 2400, region: 'eu-west-1' },
});
```

## Getting an API key

In the app: **Settings → API Keys → New Key** (requires `admin` or `super_admin`).
The key is shown **once** — copy it then.

The key resolves both your tenant and your project. There is no project id to pass:
one key per project, and staging and production keys are different keys.

## Alerts

```ts
const { data, meta } = await sigtake.alerts.ingest({
  title: 'Payment webhook failing',
  source: 'payments-worker',
  team_code: 'PAY',
  severity: 'critical',        // 'critical' | 'high' | 'medium' | 'low' | 'info', defaults to 'info'
  payload: { attempt: 3 },     // optional, must serialize to 8 KB or less
});

data.id;                 // alert id
meta.is_duplicate;       // true when it folded into an open incident
meta.occurrence_count;   // how many times this incident has fired
```

Alerts are deduplicated on `source | title | severity` per project. An open alert
with the same fingerprint gets its occurrence count bumped instead of opening a
second incident, and notifications go out at occurrences 1, 10, 25, 50, 100, then
every 100.

`team_code` must exist in your tenant **and** the team must be assigned to the
project this API key belongs to. If it isn't, the call fails with
`code: 'TEAM_NOT_IN_PROJECT'` — assign the team to the project in the app.

## Signals

```ts
// Flat object — the common case
await sigtake.signals.send('billing-service', {
  emails_sent: 42,
  queue_depth: 3,
});

// Explicit readings
await sigtake.signals.ingest({
  source: 'billing-service',
  readings: [{ metric: 'emails_sent', value: 42 }],
});
```

`source` is the monitor's source key, which must already exist in the project.
Up to 100 readings per call, 50 distinct metric names per monitor.

Hitting the metric cap answers with a **partial delivery** rather than an error —
the readings that fit were stored:

```ts
const result = await sigtake.signals.send('billing-service', metrics);
if (result.rejected) {
  console.warn('metric cap reached, dropped:', result.rejected);
}
```

A total rejection (nothing stored) throws `SigtakeValidationError`.

## Errors

Every failure is a `SigtakeError` subclass carrying `status`, `code`, and the raw
`body`.

```ts
import { SigtakeRateLimitError, SigtakeValidationError } from '@sigtake/sdk';

try {
  await sigtake.alerts.ingest(input);
} catch (err) {
  if (err instanceof SigtakeValidationError) console.error(err.fieldErrors);
  if (err instanceof SigtakeRateLimitError) console.error('retries exhausted');
  throw err;
}
```

| Class | When |
|---|---|
| `SigtakeValidationError` | 400, the total-rejection 422, and local input checks (`status: 0`) |
| `SigtakeAuthError` | 401 — missing, invalid or disabled key |
| `SigtakeNotFoundError` | 404 — no monitor with that source in this project |
| `SigtakeConflictError` | 409 — monitor is paused |
| `SigtakeRateLimitError` | 429, after retries are exhausted |
| `SigtakeServerError` | 5xx, after retries are exhausted |
| `SigtakeNetworkError` | DNS, connection, or timeout (`status: 0`) |

408, 429, 5xx and network failures are retried with exponential backoff and
jitter. Validation errors never are.

## Configuration

```ts
new Sigtake({
  apiKey: 'sk_...',
  baseUrl: 'https://api.sigtake.com',  // default
  timeout: 10_000,                     // ms, per attempt
  maxRetries: 3,                       // 0 disables retries
  headers: {},                         // merged into every request
  fetch: undefined,                    // override the global fetch
});
```

Per call:

```ts
await sigtake.alerts.ingest(input, { timeout: 2_000, signal: controller.signal });
```

Alert ingestion is best treated as fire-and-forget — never let it break the code
path that produced the alert:

```ts
sigtake.alerts.ingest(input).catch((err) => logger.warn({ err }, 'sigtake ingest failed'));
```

## Releasing

```bash
npm version patch    # or minor / major — tags as sdk-node-vX.Y.Z
git push --follow-tags
```

The tag triggers the publish workflow, which refuses to publish if the tag and
`package.json` disagree.

## License

MIT
