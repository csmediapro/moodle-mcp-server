import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MoodleClient } from "../moodle/client.js";
import type { MoodleCapabilities } from "../moodle/capabilities.js";
import type { Authenticator } from "../auth/authenticator.js";
import {
  buildToolDefinitions as buildCoreToolDefinitions,
  buildToolHandlers as buildCoreToolHandlers,
} from "../tools/index.js";

/**
 * A tool module — the contract that both core tools and plugin tools adhere to.
 * Exported here so plugin-loader.ts and factory.ts can share it without circular deps.
 */
export interface ToolModule {
  name: string;
  description: string;
  inputSchema: unknown;
  createHandler: (
    client: MoodleClient,
    caps: MoodleCapabilities
  ) => (args: unknown) => Promise<unknown>;
}

/**
 * Type for a log function used by the factory.
 * Matches the signature of the existing log() in logging/index.ts
 */
export type LogFn = (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;

/**
 * Shared server factory — creates a fully configured MCP server
 * instance ready for any transport (stdio, Streamable HTTP, etc.).
 */
export interface ServerFactoryOptions {
  name: string;
  version: string;
  moodleClient: MoodleClient;
  capabilities: MoodleCapabilities;
  authenticator: Authenticator;
  log: LogFn;
  /** Extra tool modules from plugin loader */
  extraTools?: ToolModule[];
}

export interface ServerFactoryResult {
  server: Server;
  toolCount: number;
}

export function createServer(opts: ServerFactoryOptions): ServerFactoryResult {
  // Build core definitions + handlers
  const toolDefinitions = buildCoreToolDefinitions();
  const toolHandlers = buildCoreToolHandlers(opts.moodleClient, opts.capabilities);

  // Register plugin tools (if any loaded)
  for (const mod of opts.extraTools ?? []) {
    if (toolHandlers[mod.name]) {
      opts.log("warn", `Plugin tool '${mod.name}' shadows a core tool — skipping`);
      continue;
    }
    toolHandlers[mod.name] = mod.createHandler(opts.moodleClient, opts.capabilities);
    toolDefinitions.push({
      name: mod.name,
      description: mod.description,
      inputSchema: mod.inputSchema as never,
    });
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
      opts.log(
        success ? "info" : "error",
        `Tool: ${name} ${success ? "✓" : "✗"} (${durationMs}ms)`,
        { tool: name, args, success, durationMs, resultSize, error }
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return { server, toolCount: toolDefinitions.length };
}
