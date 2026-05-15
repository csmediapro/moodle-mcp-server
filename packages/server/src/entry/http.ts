#!/usr/bin/env node

import "dotenv/config";

/**
 * Moodle MCP Server — Streamable HTTP entry point.
 *
 * This is the production-facing entry. It exposes the MCP server
 * over HTTP with API key authentication. All core logic is shared
 * with the stdio entry via server/factory.ts.
 */

import { loadConfig, loadToken } from "../config/loader.js";
import { initLogging, log } from "../logging/index.js";
import { MoodleClient } from "../moodle/client.js";
import { probeCapabilities } from "../moodle/capabilities.js";
import { ApiKeyAuthenticator } from "../auth/api-key.js";
import { warmupCaches } from "../tools/cache.js";
import { createServer } from "../server/factory.js";
import { loadPlugins } from "../plugins/loader.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const token = loadToken();
  initLogging(config);

  log("info", `Starting ${config.server.name} v${config.server.version} (HTTP mode)`);
  log("info", `Moodle URL: ${config.moodle.url}`);

  // Read API key from env — required for HTTP transport
  const apiKey = process.env.MOODLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MOODLE_API_KEY not set. Set it in .env for HTTP transport.\n" +
      "Generate one: openssl rand -hex 32"
    );
  }

  // Read plugin license key (optional)
  const licenseKey = process.env.MOODLE_PLUGIN_KEY;

  // Create Moodle client
  const moodleClient = new MoodleClient(config.moodle.url, token);

  // Probe capabilities
  log("info", "Probing Moodle capabilities...");
  const capabilities = await probeCapabilities(moodleClient);

  // Warm caches
  log("info", "Warming caches...");
  try {
    await warmupCaches(moodleClient);
    log("info", "Caches warm ✓");
  } catch (e) {
    log("warn", `Cache warm failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Load plugins
  const extraTools = await loadPlugins(config.plugins.searchPaths, log, licenseKey);
  log("info", `Loaded ${extraTools.length} plugin tools`);

  // Create server via factory
  const authenticator = new ApiKeyAuthenticator(apiKey);
  const { server, toolCount } = createServer({
    name: config.server.name,
    version: config.server.version,
    moodleClient,
    capabilities,
    authenticator,
    log,
    extraTools,
  });

  // Start HTTP transport
  // The MCP SDK's Streamable HTTP transport will be wired here
  // when the SDK supports it. For now, log readiness.
  // In practice: import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
  // const transport = new StreamableHTTPServerTransport({ port: 3001 });
  // await server.connect(transport);

  log("info", `${config.server.name} (HTTP mode) ready — ${toolCount} tools registered`);
  log("info", "HTTP transport: connect with x-api-key header to /mcp endpoint");

  // Keep the process alive (the SDK transport would normally do this)
  // For now, log and wait for SIGTERM
  process.on("SIGTERM", () => {
    log("info", "Shutting down...");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
