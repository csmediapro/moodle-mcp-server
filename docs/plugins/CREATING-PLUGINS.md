# Creating Plugins

This is the shortest path to building a plugin for the `moodle-mcp-server` core.

## Expectations

A plugin is:

- a standalone package or compiled module
- installed into one of the core's configured `plugins.searchPaths`
- loaded at server startup
- registered only through the public plugin contract
- optionally given a shutdown hook that runs during graceful core shutdown

Do not import private internals from the core outside the documented contracts.

## Minimal Example

```ts
import { z } from "zod";
import type { MCPServerPlugin } from "../../packages/server/src/plugins/contracts.js";

export const plugin: MCPServerPlugin = {
  manifest: {
    id: "com.example.hello",
    name: "Hello Plugin",
    version: "1.0.0",
    apiVersion: "1",
    description: "Example plugin showing the public contract",
    requiresLicense: false,
    requiredCapabilities: [],
    tools: ["hello_plugin"],
  },
  shutdown: async (ctx) => {
    ctx.log("info", "hello_plugin shutting down");
  },
  tools: [
    {
      name: "hello_plugin",
      description: "Return a simple plugin test payload",
      inputSchema: z.object({
        name: z.string().default("world"),
      }),
      createHandler: (ctx) => async (args) => {
        const input = args as { name?: string };
        ctx.log("info", `hello_plugin invoked for ${input.name ?? "world"}`);

        return {
          ok: true,
          greeting: `Hello, ${input.name ?? "world"}`,
          server: ctx.config.serverName,
          licensed: ctx.license.status === "valid",
        };
      },
    },
  ],
};

export default plugin;
```

## Required Steps

1. Export a `plugin` object or default export matching `MCPServerPlugin`
2. Give the plugin a stable `manifest.id`
3. Declare every tool name in `manifest.tools`
4. Define one `tools[]` entry per declared tool
5. Compile the plugin to `.js`
6. Place the compiled output in a configured plugin search path
7. Restart the core

Supported search-path layouts:

- direct compiled `.js` file
- package directory with `package.json` pointing at `main` or `module`
- directory with `index.js`
- parent directory containing multiple plugin package subdirectories

## Configuring The Core

Add a plugin search path in `packages/server/config.json`.

```json
{
  "plugins": {
    "searchPaths": [
      {
        "path": "./plugins-local",
        "requiresLicense": false
      }
    ]
  }
}
```

For premium paths:

```json
{
  "plugins": {
    "searchPaths": [
      {
        "path": "./plugins-premium",
        "requiresLicense": true
      }
    ]
  }
}
```

If a search path requires a license, set `PLUGINS_LICENSE_KEY` before starting the server.

Runtime note:

- the current core still accepts `MOODLE_PLUGIN_KEY` as a fallback
- new automation should prefer `PLUGINS_LICENSE_KEY`

## Capability Gating

Use `manifest.requiredCapabilities` for Moodle functions the plugin cannot operate without.

Example:

```ts
requiredCapabilities: [
  "gradereport_user_get_grade_items",
  "core_enrol_get_enrolled_users",
];
```

If the connected Moodle instance does not expose those functions, the plugin will be skipped and the core will log why.

## Optional Initialization

Use `initialize(ctx)` when the plugin needs startup validation or one-time setup.

Good uses:

- check derived plugin config
- log plugin startup metadata
- warm plugin-local read-only lookup structures

Bad uses:

- network side effects that change external state
- depending on implicit core internals
- hiding required failures

If initialization throws, the plugin is not loaded.

## Optional Shutdown

Use `shutdown(ctx)` when the plugin needs graceful cleanup during core shutdown.

Good uses:

- flushing buffered plugin-local state
- closing plugin-owned handles
- logging final plugin metrics

Bad uses:

- blocking shutdown on long remote operations
- assuming shutdown is always called after partial initialization failures

Shutdown failures are logged and reported, but they do not stop overall core shutdown.

## Input Schemas

Plugin tools may use:

- Zod schemas
- plain JSON-schema-like objects

Zod is the better default because core tools already use it heavily.

## Logging And Failure Style

Plugin failures should be boring and inspectable.

Prefer:

- explicit thrown errors with concrete reasons
- clear capability checks
- license-aware errors
- deterministic startup failure behavior
- idempotent startup and shutdown behavior where practical

Avoid:

- silent no-ops
- magical feature flags
- implicit fallback behavior the operator cannot observe

## Recommended Packaging Pattern

Keep each plugin as its own package with:

- its own `package.json`
- its own build step
- compiled `.js` output copied or installed into a plugin search path

That keeps the AGPL core boundary clean and makes commercial plugin distribution straightforward later.

## Current Limits

Right now the contract is intentionally narrow:

- no dedicated plugin-specific config section beyond what your plugin can derive from the host
- no dependency graph between plugins
- no lifecycle beyond load-time initialization plus optional shutdown
- no hot reload; restart required

That is deliberate. Keep the first contract small enough to stay stable.

## Related

- [Plugin Contract](./CONTRACT.md)
- `packages/server/src/plugins/contracts.ts`
- `examples/plugins/hello-plugin`
