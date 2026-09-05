/**
 * Shared MCP initialization helper.
 *
 * Reads config.json and initializes the MCP client singleton.
 * In HTTP mode, the auth token is read from the request header
 * `X-Agent-Edge-Token` or the `MCP_AGENT_EDGE_TOKEN` env var.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initMCPClient, type McpClientConfig } from "./mcp-client";

let mcpInitialized = false;
let currentToken: string | undefined;

/**
 * Ensure the MCP client is initialized, optionally with an auth token
 * for HTTP mode. The token is only applied on first init — subsequent
 * calls are no-ops (the singleton is already connected).
 */
export async function ensureMCPReady(token?: string): Promise<void> {
  if (mcpInitialized) return;

  const configPath = resolve(process.cwd(), "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    mcp: McpClientConfig;
  };

  // If a token was passed and the config is HTTP mode, inject it
  if (token && "endpoint" in config.mcp && !(config.mcp as { authToken?: string }).authToken) {
    (config.mcp as { authToken?: string }).authToken = token;
  }

  await initMCPClient(config.mcp);
  mcpInitialized = true;
  currentToken = token;
}

/**
 * Reset the initialization state (e.g. if the token changes).
 * The next ensureMCPReady call will re-initialize with the new token.
 */
export function resetMCPInit(): void {
  mcpInitialized = false;
  currentToken = undefined;
}

/**
 * Read the Agent Edge token from request headers.
 */
export function tokenFromHeaders(headers: Headers): string | undefined {
  return headers.get("x-agent-edge-token") || undefined;
}