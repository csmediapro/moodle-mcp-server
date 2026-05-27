import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MoodleClient } from "../moodle/client.js";
import type { MoodleCapabilities } from "../moodle/capabilities.js";
import type { Authenticator } from "../auth/authenticator.js";
import { logToolCall } from "../logging/index.js";
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";
import {
  buildToolDefinitions as buildCoreToolDefinitions,
  buildToolHandlers as buildCoreToolHandlers,
} from "../tools/index.js";
import type { LoadedPlugin } from "../plugins/contracts.js";

/**
 * Type for a log function used by the factory.
 * Matches the signature of the existing log() in logging/index.ts
 */
export type LogFn = (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;

/**
 * Shared server factory — creates a fully configured MCP server
 * instance ready for the stdio core and future external wrappers.
 */
export interface ServerFactoryOptions {
  name: string;
  version: string;
  moodleClient: MoodleClient;
  capabilities: MoodleCapabilities;
  authenticator: Authenticator;
  log: LogFn;
  /** Extra validated plugin bundles from the plugin loader */
  extraPlugins?: LoadedPlugin[];
}

export interface ServerFactoryResult {
  server: Server;
  toolCount: number;
}

function isZodSchema(schema: unknown): boolean {
  return !!schema &&
    typeof schema === "object" &&
    "_def" in (schema as Record<string, unknown>) &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function";
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    return zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0]);
  }

  if (schema && typeof schema === "object") {
    return schema as Record<string, unknown>;
  }

  return { type: "object", properties: {} };
}

function sanitizeArgsForTelemetry(args: unknown): unknown {
  if (Array.isArray(args)) {
    return args.map(sanitizeArgsForTelemetry);
  }

  if (args && typeof args === "object") {
    return Object.fromEntries(
      Object.entries(args as Record<string, unknown>).map(([key, value]) => {
        if (typeof value === "string" && key.toLowerCase().includes("email")) {
          const atIndex = value.indexOf("@");
          if (atIndex > 1) {
            return [key, `${value[0]}***${value.slice(atIndex)}`];
          }
          return [key, "***"];
        }
        return [key, sanitizeArgsForTelemetry(value)];
      })
    );
  }

  return args;
}

export function createServer(opts: ServerFactoryOptions): ServerFactoryResult {
  // Build core definitions + handlers
  const toolDefinitions = buildCoreToolDefinitions();
  const toolHandlers = buildCoreToolHandlers(opts.moodleClient, opts.capabilities);

  // Register plugin tools (if any loaded)
  for (const plugin of opts.extraPlugins ?? []) {
    for (const mod of plugin.tools) {
      if (toolHandlers[mod.name]) {
        opts.log(
          "warn",
          `Plugin tool '${mod.name}' from ${plugin.manifest.id} shadows an existing tool — skipping`,
        );
        continue;
      }
      toolHandlers[mod.name] = mod.createHandler({
        moodleClient: opts.moodleClient,
        capabilities: opts.capabilities,
        log: opts.log,
        config: {
          serverName: opts.name,
          serverVersion: opts.version,
        },
        license: plugin.license,
      });
      toolDefinitions.push({
        name: mod.name,
        description: mod.description,
        inputSchema: normalizeInputSchema(mod.inputSchema) as never,
      });
    }
  }

  // Create MCP server
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } }
  );

  // Tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await opts.authenticator.authenticate({});
    return { tools: toolDefinitions };
  });

  // Tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await opts.authenticator.authenticate(request);

    const { name, arguments: args } = request.params;
    const handler = toolHandlers[name];

    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const start = Date.now();
    let success = false;
    let result: unknown;
    let error: string | undefined;

    try {
      result = await handler(args);
      success = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const durationMs = Date.now() - start;
      const resultSize = result ? JSON.stringify(result).length : undefined;
      const safeArgs = sanitizeArgsForTelemetry(args);
      logToolCall({
        tool: name,
        args: safeArgs,
        success,
        durationMs,
        resultSize,
        error,
      });
      opts.log(
        success ? "info" : "error",
        `Tool: ${name} ${success ? "✓" : "✗"} (${durationMs}ms)`,
        { tool: name, args: safeArgs, success, durationMs, resultSize, error }
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return { server, toolCount: toolDefinitions.length };
}
