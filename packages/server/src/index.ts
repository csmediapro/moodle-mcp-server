#!/usr/bin/env node

import "dotenv/config";

/**
 * Moodle MCP Server — stdio entry point.
 *
 * This is the default / development entry. It runs the MCP server
 * over stdio (for use as a subprocess by AI clients like Claude Desktop,
 * VS Code, etc.). Both this entry and the HTTP entry share all core
 * logic via server/factory.ts.
 */

import { loadConfig, loadToken } from "./config/loader.js";
import { initLogging, log } from "./logging/index.js";
import { MoodleClient } from "./moodle/client.js";
import { probeCapabilities } from "./moodle/capabilities.js";
import { NoopAuthenticator } from "./auth/noop.js";
import { warmupCaches } from "./tools/cache.js";
import { createServer } from "./server/factory.js";
import { loadPlugins } from "./plugins/loader.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const token = loadToken();
  initLogging(config);

  log("info", `Starting ${config.server.name} v${config.server.version}`);
  log("info", `Moodle URL: ${config.moodle.url}`);

  // Optional license key for premium plugins
  const licenseKey = process.env.MOODLE_PLUGIN_KEY;

  // 1. Create Moodle API client
  const moodleClient = new MoodleClient(config.moodle.url, token);

  // 2. Probe Moodle capabilities
  log("info", "Probing Moodle capabilities...");
  const capabilities = await probeCapabilities(moodleClient);

  // 3. Warm caches (categories + courses)
  log("info", "Warming caches (categories + courses in parallel)…");
  try {
    await warmupCaches(moodleClient);
    log("info", "Caches warm ✓ — ready for instant queries");
  } catch (e) {
    log("warn", `Cache warm failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Load plugins from configured search paths
  const extraTools = await loadPlugins(config.plugins.searchPaths, log, licenseKey);
  if (extraTools.length > 0) {
    log("info", `Loaded ${extraTools.length} plugin tools`);
  }

  // 5. Create server via shared factory
  const { server, toolCount } = createServer({
    name: config.server.name,
    version: config.server.version,
    moodleClient,
    capabilities,
    authenticator: new NoopAuthenticator(),
    log,
    extraTools,
  });

  log("info", `Registered ${toolCount} tools`);

  // 6. Wire up stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", `${config.server.name} ready — waiting for tool calls via stdio`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
