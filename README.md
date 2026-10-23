<p align="center">
  <img src="https://raw.githubusercontent.com/Sigtake/node-sdk/main/assets/logo.png" alt="Sigtake" width="72" height="72" />
</p>

# @sigtake/sdk

Official Node.js SDK for [Sigtake](https://sigtake.com). Sends alerts, signal
readings and heartbeat pings. Zero dependencies, ESM + CJS, typed.

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
  links: [                     // optional, up to 5, http(s) only
    { label: 'Runbook', url: 'https://wiki.example.com/runbooks/payments' },
    { label: 'Dashboard', url: 'https://grafana.example.com/d/payments' },
  ],
});

data.id;                 // alert id
meta.is_duplicate;       // true when it folded into an open incident
meta.occurrence_count;   // how many times this incident has fired
```

`links` show up as buttons on the alert in the app, email, Slack and Teams. Labels
are 1–80 characters; URLs must be `http` or `https`, up to 1024 characters, without
`user:pass@`. On a dedup hit new links are added to the open alert's, never
replacing the ones already there.

The response never echoes `payload` back. On a dedup hit the alert you get is the
pre-existing one, and its payload may have been written by a different sender.

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

## Heartbeats

A heartbeat watches a job: a cron, a queue worker, a Lambda. It needs **no API key**:
the ping URL shown on the heartbeat in Sigtake is the credential.

```ts
import { heartbeat } from '@sigtake/sdk';

const backup = heartbeat(process.env.BACKUP_PING_URL!);

await backup.wrap(() => runBackup());
```

`wrap` reports the start, runs the job, then reports success, or a failure with exit
code 1 and rethrows the job's error as is. It waits for every ping before resolving,
so a Lambda does not freeze with a ping in flight.

If you already have a client, `sigtake.heartbeat(url)` is the same function. It shares
only the client's `fetch`; the API key and custom headers are never sent with a ping.

```ts
import { Sigtake } from '@sigtake/sdk';

const sigtake = new Sigtake({ apiKey: process.env.SIGTAKE_API_KEY! });
const invoices = sigtake.heartbeat(process.env.INVOICES_PING_URL!);

await invoices.wrap(async () => {
  const failed = await processInvoices();
  if (failed.length) {
    await sigtake.alerts.ingest({
      title: `${failed.length} invoices failed`,
      severity: 'medium',
      source: 'invoices',
      team_code: 'OPS',
    });
  }
});
```

By hand, with your own exit code:

```ts
const run = await backup.start();
try {
  await runBackup();
  await run.success();
} catch (err) {
  await run.fail({ exitCode: 2 });
  throw err;
}
```

A job without a start, like a cron that only reports when it ends, calls
`backup.success()` or `backup.fail({ exitCode })` directly. Without a start, a run that
dies silently is only caught by the check's schedule, never by its maximum duration.

### Run ids

Every `start()` and `wrap()` sends a run id (`rid`), a random UUID unless you pass your
own:

```ts
await invoices.wrap(() => processLead(lead), { rid: `lead-${lead.id}` });
```

- 1–64 characters of letters, digits, `.`, `_`, `:` and `-`.
- Unique **while the run is open**: two overlapping runs with the same `rid` are measured
  as one. If the same lead can run twice in parallel, add the attempt: `lead-${id}-${attempt}`.
- Not a secret: it shows in the check's history and in server logs. No emails or tokens.
- Honoured on **on demand** checks only; scheduled checks ignore it.

### Failed pings never break the job

`start`, `success` and `fail` never reject: they resolve `true` when the ping was
delivered and `false` otherwise. A failed ping goes to `onError`, which defaults to
`console.warn`, so a rotated token does not go unnoticed.

```ts
heartbeat(url, {
  timeout: 5_000,   // ms, per attempt
  maxRetries: 2,    // network errors and 5xx only
  onError: (err) => logger.warn({ err }, 'heartbeat ping failed'),  // () => {} to silence
});
```

| Error passed to `onError` | When |
|---|---|
| `SigtakeNotFoundError` | 404: unknown or rotated token, or the check is archived |
| `SigtakeValidationError` | 400 from the server, or an invalid `rid` / `exitCode` caught locally (`status: 0`, nothing sent) |
| `SigtakeRateLimitError` | 429: too many pings or open runs for this check; never retried |
| `SigtakeServerError` | 5xx, after retries |
| `SigtakeNetworkError` | DNS, connection or timeout, after retries |

An invalid ping URL throws a `TypeError` when the heartbeat is created, so a bad
configuration fails at boot.

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
