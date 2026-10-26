# Changelog

All notable changes to `@sigtake/sdk` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-26

### Added

- `heartbeat(token)` and `sigtake.heartbeat(token)` take the heartbeat's token alone; the
  SDK builds the ping URL. New `baseUrl` heartbeat option, defaulting to
  `https://api.sigtake.com`; `sigtake.heartbeat()` uses the client's `baseUrl`. A full
  ping URL is still accepted and keeps its own host.

## [0.4.0] - 2026-10-23

### Added

- `heartbeat(pingUrl)` and `sigtake.heartbeat(pingUrl)` for Sigtake Heartbeats:
  `start()`, `success()`, `fail({ exitCode })` and `wrap(fn)`. No API key needed, the
  ping URL is the credential. Each run sends a run id (`rid`), a random UUID or your
  own, so concurrent runs of an on demand check are tracked separately. Pings never
  reject: failures go to `onError`, which defaults to `console.warn`. New exported
  types `Heartbeat`, `HeartbeatRun`, `HeartbeatOptions`, `RunOptions`, `FailOptions`.

## [0.3.0] - 2026-10-06

### Added

- `links` on `alerts.ingest()`: up to 5 `{ label, url }` reference links
  (runbook, dashboard, logs), validated locally with the server's rules —
  http(s) only, no embedded credentials, labels of 1–80 characters. On a dedup
  hit they are merged into the open alert's links. New exported type
  `AlertLink`. Requires a Sigtake API that supports links; older ones ignore
  the field.

## [0.2.0] - 2026-08-18

### Removed

- **BREAKING** — `payload` is gone from the `Alert` returned by `alerts.ingest()`.
  The server no longer sends it: on a dedup hit the response carries the
  pre-existing alert, whose payload may belong to a different sender, so echoing
  it turned an ingest key into a way to read other senders' data. Reading
  `result.data.payload` is now a compile error; the payload you send is
  unaffected.

  The same release drops `tenant_id`, `project_id`, `team_id` and `api_key_id`
  from the wire response. This SDK never exposed them, so nothing changes here.

## [0.1.0] - 2026-08-11

### Added

- First release: `alerts.ingest()`, `signals.ingest()` and `signals.send()`,
  typed errors, and retries with exponential backoff on 408/429/5xx/network.
