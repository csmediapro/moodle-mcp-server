# Core Supervision Contract

This document defines the runtime contract between the `moodle-mcp-server` core and the edge service that supervises it on the same machine.

The edge service is a deterministic code-based supervisor, not an inference-based agent.

## Process Model

- The edge service starts the core as a child subprocess.
- MCP protocol traffic flows over the core's `stdout`.
- Supervision status events flow over the core's `stderr`.
- The edge service is responsible for process lifecycle, restart policy, backoff, registration, connectivity, and remote control.

The OSS core intentionally remains `stdio`-only. It does not expose HTTP for readiness or control.

## Stream Contract

### `stdout`

Reserved for MCP JSON-RPC bytes only.

The supervisor must treat `stdout` as protocol traffic and must not expect human-readable logs or status messages there.

### `stderr`

Carries two kinds of JSONL output:

- general structured logs
- structured supervision status events

Status events are emitted as newline-delimited JSON with:

- `ts`: ISO timestamp
- `stream`: always `"status"`
- `type`: event name

The supervisor should treat this as an additive contract:

- existing event names and meanings should remain stable
- new event types may be added over time
- new optional fields may be added over time
- the supervisor should only hard-depend on the minimal required startup contract

Example:

```json
{"ts":"2026-05-26T22:00:00.000Z","stream":"status","type":"identity_ready","serverId":"mcp_8f3k2q9x","serverName":"Moodle Production","serverVersion":"0.1.0"}
```

## Lifecycle Event Contract

The core emits these status events during startup and shutdown.

### `startup_begin`

Emitted before config load begins.

Fields:

- `serverName`
- `serverVersion`

### `config_loaded`

Emitted after config has been loaded and validated.

Fields:

- `configPath`
- `serverId`
- `serverName`
- `serverVersion`

### `identity_ready`

Emitted after stable server identity is known.

Fields:

- `serverId`
- `serverName`
- `serverVersion`

### `token_loaded`

Emitted after `MOODLE_TOKEN` has been loaded successfully.

No additional fields.

### `moodle_probe_begin`

Emitted immediately before Moodle capability probing.

Fields:

- `moodleUrl`

### `moodle_probe_ok`

Emitted after Moodle capability probing succeeds.

Fields:

- `capabilityCount`

### `cache_warm_ok`

Emitted when cache warmup succeeds.

No additional fields.

### `cache_warm_failed`

Emitted when cache warmup fails. This is non-fatal.

Fields:

- `reason`

### `plugin_loaded`

Emitted once per successfully loaded plugin.

Fields:

- `pluginId`
- `pluginVersion`
- `entryPath`
- `toolCount`

### `plugin_skipped`

Emitted once per skipped plugin or plugin path condition.

Fields:

- `reasonCode`
- `message`
- `entryPath` optional
- `pluginId` optional

This event is non-fatal by itself. The supervisor should use it for observability, not as a startup-failure signal unless a corresponding `fatal` event occurs.

### `ready`

Emitted after stdio transport has connected and the core is ready to serve MCP calls.

Fields:

- `toolCount`
- `pluginCount`

This is the readiness event the supervisor should wait for before marking the node healthy.

### `shutdown_begin`

Emitted when shutdown has started due to signal handling.

Fields:

- `signal`

### `fatal`

Emitted when startup cannot continue.

Fields:

- `code`
- `stage`
- `message`

`fatal` is terminal for the current startup attempt.

## Failure Contract

The supervisor should classify `fatal.code` values as follows.

### `config_invalid`

Startup config could not be parsed or validated.

Expected action:

- do not blind-retry aggressively
- surface to operator

### `config_unwritable`

The core needed to persist generated config state, usually `server.id`, but the resolved config path was not writable.

Expected action:

- do not blind-retry aggressively
- surface to operator

### `token_missing`

`MOODLE_TOKEN` was absent or invalid.

Expected action:

- do not blind-retry aggressively
- surface to operator

### `moodle_unreachable`

The core could not reach Moodle during capability probing. This is used for clearly retryable connectivity or upstream availability failures.

Expected action:

- retry with backoff if external connectivity may recover

### `capability_probe_failed`

The Moodle capability probe failed during startup.

Expected action:

- retry with backoff if Moodle may recover
- surface if persistent

### `plugin_load_failed`

Plugin loading failed at a startup-blocking level.

Expected action:

- inspect plugin-related `plugin_skipped` and logs
- retry only if the failure source is expected to recover

### `server_start_failed`

The core could not finish MCP stdio server startup.

Expected action:

- retry with backoff
- surface if repeated

## Plugin Skip Reason Codes

Current `plugin_skipped.reasonCode` values:

- `path_missing`
- `package_invalid`
- `entry_missing`
- `load_failed`
- `export_missing`
- `manifest_invalid`
- `tools_invalid`
- `capability_missing`
- `initialize_failed`

These codes are intended to be additive. New reason codes may be introduced when the supervisor harness exposes ambiguity that matters operationally.

## Config Launch Contract

The supervisor may control startup through:

- `MOODLE_MCP_CONFIG` or `MOODLE_MCP_SERVER_CONFIG` for config path selection
- `SERVER_ID`
- `SERVER_NAME`
- `SERVER_VERSION`
- `MOODLE_TOKEN`

`server.id` rules:

- if present in config, use it
- if absent and `SERVER_ID` is set, use the explicit override
- if absent in config and no `SERVER_ID` is set, generate one once and persist it
- if persistence is impossible, startup fails

This guarantees stable identity for the supervisor.

## Minimal Required Contract

The supervisor should hard-depend only on this minimal startup contract:

- `startup_begin`
- `config_loaded`
- `identity_ready`
- `moodle_probe_begin`
- `moodle_probe_ok`
- `ready`
- `shutdown_begin`
- `fatal`

Everything else should be treated as additive observability.

## Readiness Rules For The Edge Service

The edge service should:

1. spawn the core
2. treat `stdout` as MCP-only
3. parse `stderr` as JSONL
4. wait for `ready`
5. treat `fatal` as startup failure
6. treat exit before `ready` as startup failure
7. apply backoff and restart policy in supervisor code, not in the core

## Why This Contract Exists

The goal is to let the OSS MCP core and the leased edge connectivity layer fit together like separate Lego pieces:

- the core is the local MCP engine
- the edge service is the deterministic control and connectivity layer

That separation only works if the subprocess contract is explicit and boring.
