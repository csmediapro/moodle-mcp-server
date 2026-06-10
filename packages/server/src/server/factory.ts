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
import * as getCapabilities from "../tools/get-capabilities.js";
import * as getAgentRuntimeConfig from "../tools/get-agent-runtime-config.js";
import type { ToolCatalogEntry } from "../tools/get-capabilities.js";
import type { AgentRegistration, LoadedPlugin } from "../plugins/contracts.js";

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

const CORE_AGENT_REGISTRATION: AgentRegistration = {
  promptRules: [
    "Treat hierarchy words literally. \"Sub categories\", \"children\", \"under\", and \"inside\" mean child categories of a specific parent.",
    "When the user asks for sub categories: if they provided a parent category name, call list_categories with parentname; if they provided a parent category ID, call list_categories with parentid; if the latest category tool result already resolved a parent, reuse that resolved parentid; otherwise ask one short clarification question.",
    "Never fuzzy-match category names silently. Use exact category names or IDs. If a tool reports ambiguity, ask the user which category they mean or use the exact ID/path from the tool result.",
    "When listing course-scoped users or assignments, specify the courseid.",
  ],
  continuationActions: [
    {
      tool: "list_user_courses",
      keywords: ["course", "courses", "enrollment", "enrollments", "enrolled"],
    },
  ],
};

function mergeAgentRegistrations(
  plugins: LoadedPlugin[],
): getAgentRuntimeConfig.AgentRuntimeConfig {
  const merged = getAgentRuntimeConfig.emptyAgentRuntimeConfig();

  const append = (registration?: AgentRegistration) => {
    if (!registration) return;
    merged.promptRules.push(...(registration.promptRules ?? []));
    merged.intentRoutes.push(...(registration.intentRoutes ?? []));
    merged.toolRewrites.push(...(registration.toolRewrites ?? []));
    merged.continuationActions.push(...(registration.continuationActions ?? []));
  };

  append(CORE_AGENT_REGISTRATION);

  for (const plugin of plugins) {
    if (!plugin.agent) continue;
    append(plugin.agent);
    merged.plugins.push({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
    });
  }

  return merged;
}

export function createServer(opts: ServerFactoryOptions): ServerFactoryResult {
  // Build core definitions + handlers
  const toolDefinitions = buildCoreToolDefinitions();
  const toolHandlers = buildCoreToolHandlers(opts.moodleClient, opts.capabilities);
  const agentRuntimeConfig = mergeAgentRegistrations(opts.extraPlugins ?? []);
  const toolCatalog: ToolCatalogEntry[] = toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    source: "core",
  }));

  toolHandlers[getCapabilities.name] = getCapabilities.createHandler(() => toolCatalog);
  toolDefinitions.push({
    name: getCapabilities.name,
    description: getCapabilities.description,
    inputSchema: zodToJsonSchema(getCapabilities.inputSchema) as never,
  });
  toolCatalog.push({
    name: getCapabilities.name,
    description: getCapabilities.description,
    source: "core",
  });

  toolHandlers[getAgentRuntimeConfig.name] = getAgentRuntimeConfig.createHandler(() => agentRuntimeConfig);
  toolDefinitions.push({
    name: getAgentRuntimeConfig.name,
    description: getAgentRuntimeConfig.description,
    inputSchema: zodToJsonSchema(getAgentRuntimeConfig.inputSchema) as never,
  });
  toolCatalog.push({
    name: getAgentRuntimeConfig.name,
    description: getAgentRuntimeConfig.description,
    source: "core",
  });

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
      });
      toolDefinitions.push({
        name: mod.name,
        description: mod.description,
        inputSchema: normalizeInputSchema(mod.inputSchema) as never,
      });
      toolCatalog.push({
        name: mod.name,
        description: mod.description,
        source: "plugin",
        plugin: {
          id: plugin.manifest.id,
          name: plugin.manifest.name,
        },
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
