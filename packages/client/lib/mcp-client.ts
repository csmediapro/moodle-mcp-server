/**
 * MCP Client wrapper — manages the MCP server subprocess lifecycle.
 *
 * On startup, spawns the MCP server via StdioClientTransport,
 * lists its available tools, and exposes listTools() / callTool().
 *
 * The tools list is shared across all LLM providers — each adapter
 * translates the same set of tool definitions into its own format.
 *
 * ⚠️ This uses Node.js child_process and the MCP SDK client-side
 * transport. It only works server-side (Node.js runtime), which is
 * why it lives behind an API route in the Next.js app.
 *
 * ⚠️ Singleton via globalThis: Next.js dev mode can instantiate this
 * module separately for each route chunk. globalThis bypasses that —
 * one client, one MCP server subprocess, one cache for all routes.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import type { Tool } from "./llm/types";

const GLOBAL_KEY = "__moodle_mcp_client__";

interface MCPSingleton {
  client: Client | null;
  transport: StdioClientTransport | null;
  toolsCache: Tool[] | null;
  agentRuntimeConfig: AgentRuntimeConfig | null;
  initialized: boolean;
}

export type AgentCaptureTransform = "filterKey" | "filterValue" | "number";

export type AgentCapture =
  | {
      kind: "arg";
      name: string;
      group: string | number;
      transform?: AgentCaptureTransform;
    }
  | {
      kind: "filter";
      target: string;
      fieldGroup: string | number;
      valueGroup: string | number;
      fieldTransform?: AgentCaptureTransform;
      valueTransform?: AgentCaptureTransform;
    };

export interface AgentIntentRoute {
  id: string;
  description?: string;
  match: string;
  flags?: string;
  tool: string;
  args?: Record<string, unknown>;
  captures?: AgentCapture[];
  exclude?: string[];
}

export interface AgentToolRewrite {
  id: string;
  description?: string;
  whenTool: string;
  match: string;
  flags?: string;
  tool: string;
  args?: Record<string, unknown>;
  captures?: AgentCapture[];
  exclude?: string[];
}

export interface AgentContinuationAction {
  tool: string;
  keywords: string[];
}

export interface AgentRuntimeConfig {
  promptRules: string[];
  intentRoutes: AgentIntentRoute[];
  toolRewrites: AgentToolRewrite[];
  continuationActions: AgentContinuationAction[];
  plugins?: Array<{
    id: string;
    name: string;
    version: string;
  }>;
}

const EMPTY_AGENT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  promptRules: [],
  intentRoutes: [],
  toolRewrites: [],
  continuationActions: [],
  plugins: [],
};

function getStore(): MCPSingleton {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      client: null,
      transport: null,
      toolsCache: null,
      agentRuntimeConfig: null,
      initialized: false,
    };
  }
  return g[GLOBAL_KEY] as MCPSingleton;
}

/**
 * Initialize the MCP client — spawns the server subprocess and
 * fetches the tool list. Safe to call multiple times; subsequent
 * calls are no-ops.
 */
export async function initMCPClient(mcpConfig: {
  serverCommand: string;
  serverArgs: string[];
  serverCwd?: string;
}): Promise<void> {
  const store = getStore();
  if (store.initialized) return;

  store.transport = new StdioClientTransport({
    command: mcpConfig.serverCommand,
    args: mcpConfig.serverArgs,
    ...(mcpConfig.serverCwd
      ? { cwd: resolve(/* turbopackIgnore: true */ process.cwd(), mcpConfig.serverCwd) }
      : {}),
  });

  store.client = new Client(
    { name: "moodle-mcp-client", version: "0.1.0" },
    { capabilities: {} },
  );

  await store.client.connect(store.transport);

  // Fetch and cache tools
  const response = await store.client.listTools();
  store.toolsCache = (response.tools as Tool[]) || [];
  store.agentRuntimeConfig = await fetchAgentRuntimeConfig(store.client, store.toolsCache);
  store.initialized = true;

  console.warn(
    `[mcp-client] Connected to MCP server — ${store.toolsCache.length} tools available`,
  );
}

async function fetchAgentRuntimeConfig(client: Client, tools: Tool[]): Promise<AgentRuntimeConfig> {
  if (!tools.some((tool) => tool.name === "get_agent_runtime_config")) {
    return EMPTY_AGENT_RUNTIME_CONFIG;
  }

  try {
    const result = await client.callTool({
      name: "get_agent_runtime_config",
      arguments: {},
    }, undefined, { timeout: 30_000 });

    const content = result.content as Array<{ type: string; text?: string }>;
    const textContent = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const parsed = JSON.parse(textContent) as Partial<AgentRuntimeConfig>;
    return {
      promptRules: Array.isArray(parsed.promptRules) ? parsed.promptRules : [],
      intentRoutes: Array.isArray(parsed.intentRoutes) ? parsed.intentRoutes : [],
      toolRewrites: Array.isArray(parsed.toolRewrites) ? parsed.toolRewrites : [],
      continuationActions: Array.isArray(parsed.continuationActions) ? parsed.continuationActions : [],
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
    };
  } catch (e) {
    console.warn(
      `[mcp-client] Failed to load agent runtime config: ${e instanceof Error ? e.message : String(e)}`,
    );
    return EMPTY_AGENT_RUNTIME_CONFIG;
  }
}

/**
 * List all available MCP tools (cached from last fetch).
 */
export function listTools(): Tool[] {
  const store = getStore();
  if (!store.toolsCache) {
    throw new Error(
      "MCP client not initialized. Call initMCPClient() first.",
    );
  }
  return store.toolsCache;
}

export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  const store = getStore();
  return store.agentRuntimeConfig ?? EMPTY_AGENT_RUNTIME_CONFIG;
}

/**
 * Call an MCP tool by name with the given arguments.
 * Returns the parsed result content.
 */
export async function callTool(
  name: string,
  args: unknown,
): Promise<unknown> {
  const store = getStore();
  if (!store.client) {
    throw new Error(
      "MCP client not initialized. Call initMCPClient() first.",
    );
  }

  const start = Date.now();
  console.warn(`[mcp-client] Calling tool: ${name}`);

  const result = await store.client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  }, undefined, { timeout: 180_000 });

  const durationMs = Date.now() - start;
  console.warn(`[mcp-client] Tool ${name} completed in ${durationMs}ms`);

  // Extract text content from the result
  const content = result.content as Array<{ type: string; text?: string }>;
  const textContent = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  // Parse JSON from text content if possible
  try {
    return JSON.parse(textContent);
  } catch {
    return textContent;
  }
}

/**
 * Clean up — kill the server subprocess.
 */
export async function shutdown(): Promise<void> {
  const store = getStore();
  if (store.client) {
    await store.client.close();
    store.client = null;
    store.transport = null;
    store.toolsCache = null;
    store.agentRuntimeConfig = null;
    store.initialized = false;
  }
}
