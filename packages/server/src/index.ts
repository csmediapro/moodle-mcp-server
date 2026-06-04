#!/usr/bin/env node

import "dotenv/config";

/**
 * Moodle MCP Server — stdio entry point.
 *
 * This is the default / development entry. It runs the MCP server
 * over stdio (for use as a subprocess by AI clients like Claude Desktop,
 * VS Code, etc.). Future commercial agents should supervise this core
 * as a subprocess rather than adding a network transport to the OSS package.
 */

import {
  ConfigLoadError,
  loadConfig,
  loadToken,
  resolveConfigPath,
  persistConfig,
} from "./config/loader.js";
import { emitStatus, initLogging, log } from "./logging/index.js";
import { MoodleClient } from "./moodle/client.js";
import { probeCapabilities } from "./moodle/capabilities.js";
import { NoopAuthenticator } from "./auth/noop.js";
import { warmupCaches } from "./tools/cache.js";
import { createServer } from "./server/factory.js";
import { loadPlugins } from "./plugins/loader.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const startupName = process.env.SERVER_NAME?.trim() || "Moodle MCP Server";
  const startupVersion = process.env.SERVER_VERSION?.trim() || "0.1.0";
  emitStatus({
    type: "startup_begin",
    serverName: startupName,
    serverVersion: startupVersion,
  });

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    emitStatus({
      type: "fatal",
      code: err instanceof ConfigLoadError ? err.code : "config_invalid",
      stage: "config",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  emitStatus({
    type: "config_loaded",
    configPath: resolveConfigPath(),
    serverId: config.server.id,
    serverName: config.server.name,
    serverVersion: config.server.version,
  });
  emitStatus({
    type: "identity_ready",
    serverId: config.server.id,
    serverName: config.server.name,
    serverVersion: config.server.version,
  });

  let token;
  try {
    token = loadToken();
  } catch (err) {
    emitStatus({
      type: "fatal",
      code: "token_missing",
      stage: "token",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  emitStatus({ type: "token_loaded" });

  initLogging(config);

  log("info", `Starting ${config.server.name} v${config.server.version}`);
  log("info", `Server identity: ${config.server.id}`);
  log("info", `Server display name: ${config.server.name}`);
  log("info", `Server version: ${config.server.version}`);
  log("info", `Moodle URL: ${config.moodle.url}`);

  // Optional license key for premium plugins
  const licenseKey = config.plugins.licenseKey ?? process.env.MOODLE_PLUGIN_KEY;

  // 1. Create Moodle API client
  const moodleClient = new MoodleClient(config.moodle.url, token);

  // 2. Probe Moodle capabilities
  log("info", "Probing Moodle capabilities...");
  emitStatus({
    type: "moodle_probe_begin",
    moodleUrl: config.moodle.url,
  });
  let capabilities;
  try {
    capabilities = await probeCapabilities(moodleClient);
  } catch (err) {
    emitStatus({
      type: "fatal",
      code: classifyProbeFailure(err),
      stage: "moodle_probe",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  emitStatus({
    type: "moodle_probe_ok",
    capabilityCount: capabilities.functions.size,
  });

  // Persist resolved site name to config.json for the client's static layout
  if (capabilities.siteName && capabilities.siteName !== config.server.name) {
    log("info", `Updating server name in config.json: ${config.server.name} -> ${capabilities.siteName}`);
    
    // Update active memory so the rest of the server uses the correct name
    config.server.name = capabilities.siteName;

    try {
      let currentConfig = JSON.parse(readFileSync(resolveConfigPath(), "utf-8"));
      if (currentConfig.server) {
        currentConfig.server.name = capabilities.siteName;
      } else {
        currentConfig = { ...currentConfig, server: { name: capabilities.siteName } };
      }
      persistConfig(resolveConfigPath(), currentConfig);
    } catch (e) {
      log("warn", `Failed to persist site name to config.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. Warm caches (categories + courses)
  log("info", "Warming caches (categories + courses in parallel)…");
  try {
    await warmupCaches(moodleClient);
    log("info", "Caches warm ✓ — ready for instant queries");
    emitStatus({ type: "cache_warm_ok" });
  } catch (e) {
    log("warn", `Cache warm failed: ${e instanceof Error ? e.message : String(e)}`);
    emitStatus({
      type: "cache_warm_failed",
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  // 4. Load plugins from configured search paths
  let extraPlugins;
  try {
    extraPlugins = await loadPlugins(
      config.plugins.searchPaths,
      {
        moodleClient,
        capabilities,
        log,
        emitStatus,
        config: {
          serverName: config.server.name,
          serverVersion: config.server.version,
        },
      },
      licenseKey,
    );
  } catch (err) {
    emitStatus({
      type: "fatal",
      code: "plugin_load_failed",
      stage: "plugins",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const pluginToolCount = extraPlugins.reduce(
    (count, plugin) => count + plugin.tools.length,
    0,
  );
  if (pluginToolCount > 0) {
    log("info", `Loaded ${pluginToolCount} plugin tools from ${extraPlugins.length} plugins`);
  }

  // 5. Create server via shared factory
  const { server, toolCount } = createServer({
    name: config.server.name,
    version: config.server.version,
    moodleClient,
    capabilities,
    authenticator: new NoopAuthenticator(),
    log,
    extraPlugins,
  });

  log("info", `Registered ${toolCount} tools`);

  // 6. Wire up stdio transport
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    emitStatus({
      type: "fatal",
      code: "server_start_failed",
      stage: "server_connect",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  log("info", `${config.server.name} ready — waiting for tool calls via stdio`);
  emitStatus({
    type: "ready",
    toolCount,
    pluginCount: extraPlugins.length,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `Received ${signal} — shutting down ${config.server.name}`);
    emitStatus({
      type: "shutdown_begin",
      signal,
    });

    for (const plugin of extraPlugins) {
      if (!plugin.shutdown) continue;
      try {
        await plugin.shutdown();
      } catch (e) {
        log(
          "warn",
          `Plugin shutdown failed for ${plugin.manifest.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    try {
      await server.close();
    } catch (e) {
      log(
        "warn",
        `Server close failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

function classifyProbeFailure(err: unknown): "moodle_unreachable" | "capability_probe_failed" {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes("fetch failed") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("networkerror") ||
    lower.includes("http 502") ||
    lower.includes("http 503") ||
    lower.includes("http 504")
  ) {
    return "moodle_unreachable";
  }

  return "capability_probe_failed";
}
