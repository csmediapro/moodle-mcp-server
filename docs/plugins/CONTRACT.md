# Plugin Contract

This document describes the runtime plugin contract for the `moodle-mcp-server` core.

The OSS core loads plugins from configured filesystem search paths at startup. A plugin is a compiled JavaScript module that exports a single `plugin` object (or a default export with the same shape).

## Export Shape

```ts
export interface MCPServerPlugin {
  manifest: PluginManifest;
  initialize?: (ctx: PluginContext) => Promise<void> | void;
  shutdown?: (ctx: PluginContext) => Promise<void> | void;
  tools: ToolModule[];
}
```

## Manifest

Every plugin must declare a manifest.

```ts
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: "1";
  description: string;
  requiresLicense: boolean;
  requiredCapabilities: string[];
  tools: string[];
}
```

Field meanings:

- `id`: stable globally unique plugin identifier, for example `com.csmediapro.analytics.gradebook`
- `name`: human-readable plugin name
- `version`: plugin package version
- `apiVersion`: plugin contract version implemented by the plugin; current value is `"1"`
- `description`: short human-readable summary
- `requiresLicense`: whether the plugin requires a valid premium license result to activate
- `requiredCapabilities`: Moodle Web Services functions the plugin requires before load
- `tools`: declared tool names exposed by the plugin

## Runtime Context

The core passes a typed runtime context to plugin hooks and tool handlers.

```ts
export interface PluginContext {
  moodleClient: MoodleClient;
  capabilities: MoodleCapabilities;
  log: LogFn;
  config: {
    serverName: string;
    serverVersion: string;
  };
  license: LicenseResult;
}
```

The context contract is intentionally narrow:

- `moodleClient`: direct access to the Moodle REST wrapper used by core tools
- `capabilities`: startup-probed Moodle function set
- `log`: shared structured logger
- `config`: stable host metadata currently exposed to plugins
- `license`: resolved license state for this plugin load

Plugins should treat this as the entire supported host API. Do not reach into core internals outside this contract.

## License Result

License state is explicit and inspectable.

```ts
type LicenseResult =
  | {
      status: "valid";
      tier: string;
      featuresEnabled: string[];
      identity?: string;
      expiresAt?: string;
    }
  | {
      status: "invalid" | "missing";
      reason: string;
      featuresEnabled: string[];
    };
```

Notes:

- Plugins that require a license are not loaded unless `license.status === "valid"`
- The loader logs license failures clearly and skips the plugin deterministically
- Tool handlers still receive the resolved license result so plugins can make narrower feature decisions if needed

## Tool Module Shape

Each plugin exposes one or more tool modules through `tools`.

```ts
export interface ToolModule {
  name: string;
  description: string;
  inputSchema: unknown;
  createHandler: (
    ctx: PluginContext,
  ) => (args: unknown) => Promise<unknown>;
}
```

Rules:

- `name` must be unique across core and all loaded plugins
- `description` should be user-facing and concise
- `inputSchema` may be a Zod schema or plain JSON-schema-like object
- `createHandler` receives `PluginContext` and must return the async handler function

If a plugin tool name collides with an existing tool, the core logs the shadowing event and skips that tool.

## Tool Result Shape

Plugin tools may return any MCP-compatible payload, but Moodle Report understands the structured `ToolResponse` contract exported from `packages/server/src/plugins/contracts.ts`. Use this shape when a result should render as a table, card, list, error, or deterministic follow-up action.

```ts
export interface ToolResponse {
  ok: boolean;
  meta?: {
    tool: string;
    title: string;
    generatedAt: string;
    resultCount?: number;
    entity?: string;
    entityId?: string | number;
  };
  data: {
    kind: "table" | "record" | "list" | "none";
    presentation?: "table" | "compact_card" | "full_card";
    title?: string;
    columns?: Array<{ key: string; label: string }>;
    rows?: Array<Record<string, unknown>>;
    record?: Record<string, unknown>;
    items?: unknown[];
  };
  context: {
    summary: string;
    metrics?: Record<string, string | number | boolean | null>;
    entities?: ToolEntity[];
    primaryEntity?: { type: string; id: string | number };
    highlights?: string[];
    suggestedQueries?: string[];
    fields?: string[];
    warnings?: string[];
  };
  interactions?: ToolInteractionsBlock;
}
```

### Presentation

`data.presentation` is a rendering hint. Current supported values:

- `table`: render tabular rows
- `compact_card`: render a record with only the supplied `columns`
- `full_card`: render the full record

For `compact_card`, `columns` acts as the display schema. Keep canonical IDs in `record` or `rows` even if the ID is not displayed.

### Entities And Structured Actions

Use `context.entities` to expose canonical identities that can safely be reused by the model and UI. This is the preferred handoff mechanism for compound workflows.

```ts
{
  type: "user",
  id: 14733,
  label: "Bailey Wallace",
  fields: {
    email: "bailey@example.com"
  },
  actions: [
    {
      label: "Progress report",
      tool: "get_user_progress_report",
      args: { userid: 14733 }
    }
  ]
}
```

When exactly one entity is the obvious subject of the result, also set `context.primaryEntity`.

Row and tool interactions may use either the legacy `template` form or structured action fields:

```ts
{
  type: "button",
  label: "Progress",
  tool: "get_user_progress_report",
  argsFromRow: { userid: "id" }
}
```

For row actions, `argsFromRow` maps tool argument names to row field keys. Rows must include those source keys even when the corresponding columns are hidden.

## Loader Behavior

At startup, the core:

1. Reads `config.plugins.searchPaths`
2. Resolves each search path as either:
   - a direct compiled `.js` file
   - a package-style directory with `package.json` and `module` or `main`
   - a directory with `index.js`
   - a directory containing plugin package subdirectories
3. Imports each candidate module
4. Resolves `plugin` or default export
5. Validates the manifest and tools structure
6. Resolves license state
7. Verifies required Moodle capabilities
8. Calls optional `initialize(ctx)`
9. Registers declared tools into the MCP tool registry
10. Calls optional `shutdown(ctx)` during core shutdown if the plugin loaded successfully

Observable failure cases:

- missing plugin export
- invalid package metadata or missing package entrypoint
- invalid manifest
- missing or malformed tool entries
- invalid or missing license for licensed plugins
- missing required Moodle capabilities
- manifest/tool declaration mismatches
- initialization failure
- shutdown failure is logged but does not abort shutdown

All of these should log clearly and degrade predictably by skipping the failing plugin or tool. The core also emits `plugin_loaded` and `plugin_skipped` supervision events on `stderr` for the edge service.

## Stability Boundary

Supported boundary:

- `packages/server/src/plugins/contracts.ts`
- `config.plugins.searchPaths`
- runtime load behavior documented here

Unsupported boundary:

- importing random core internals
- relying on folder structure beyond the documented exported plugin contract
- assuming plugin load order for correctness

If the contract changes incompatibly, bump `apiVersion`.
