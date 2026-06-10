/**
 * Plugin loader — scans configured search paths for MCP tool modules
 * and loads compliant plugins into the tool registry.
 *
 * Design:
 *   - Filesystem-based: drop a directory of compiled .js files into a
 *     search path, they auto-register on next server start.
 *   - Each plugin is a standalone npm package that builds independently.
 */

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { hasCapability } from "../moodle/capabilities.js";
import type { LogFn } from "../server/factory.js";
import {
  PluginManifestSchema,
  type LoadedPlugin,
  type MCPServerPlugin,
  type PluginContext,
  type PluginSearchPath,
  type ToolModule,
} from "./contracts.js";
import type { StatusEvent } from "../logging/index.js";

/**
 * Shared runtime context that the host gives every plugin.
 */
export interface PluginLoaderContextBase {
  moodleClient: PluginContext["moodleClient"];
  capabilities: PluginContext["capabilities"];
  log: PluginContext["log"];
  config: PluginContext["config"];
  emitStatus?: (event: StatusEvent) => void;
}

/**
 * Scan all configured search paths and return validated plugin bundles.
 */
export async function loadPlugins(
  searchPaths: PluginSearchPath[],
  baseContext: PluginLoaderContextBase,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];

  for (const sp of searchPaths) {
    const absPath = resolve(sp.path);
    if (!existsSync(absPath)) {
      baseContext.log("debug", `Plugin path not found, skipping: ${absPath}`);
      baseContext.emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "path_missing",
        message: `Plugin path not found: ${absPath}`,
        entryPath: absPath,
      });
      continue;
    }

    try {
      const candidates = discoverPluginCandidates(
        absPath,
        baseContext.log,
        baseContext.emitStatus,
      );
      for (const entryPath of candidates) {

        try {
          const mod = await loadModule(entryPath, baseContext);
          if (mod !== null) {
            loaded.push(mod);
            baseContext.log(
              "info",
              `Plugin loaded: ${mod.manifest.id}@${mod.manifest.version} (${entryPath})`,
            );
            baseContext.emitStatus?.({
              type: "plugin_loaded",
              pluginId: mod.manifest.id,
              pluginVersion: mod.manifest.version,
              entryPath,
              toolCount: mod.tools.length,
            });
          }
        } catch (e) {
          baseContext.log("warn", `Failed to load plugin ${entryPath}: ${e instanceof Error ? e.message : String(e)}`);
          baseContext.emitStatus?.({
            type: "plugin_skipped",
            reasonCode: "load_failed",
            message: e instanceof Error ? e.message : String(e),
            entryPath,
          });
        }
      }
    } catch (e) {
      baseContext.log("warn", `Error scanning plugin path ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return loaded;
}

function discoverPluginCandidates(
  absPath: string,
  log: LogFn,
  emitStatus?: (event: StatusEvent) => void,
): string[] {
  const stats = statSync(absPath);
  if (stats.isFile()) {
    return absPath.endsWith(".js") ? [absPath] : [];
  }

  const directModule = resolvePluginModulePath(absPath, log, emitStatus);
  if (directModule) {
    return [directModule];
  }

  const candidates: string[] = [];
  for (const entry of readdirSync(absPath)) {
    const entryPath = join(absPath, entry);
    const resolved = resolvePluginModulePath(entryPath, log, emitStatus);
    if (resolved) {
      candidates.push(resolved);
    }
  }

  return candidates;
}

function resolvePluginModulePath(
  entryPath: string,
  log: LogFn,
  emitStatus?: (event: StatusEvent) => void,
): string | null {
  if (!existsSync(entryPath)) {
    return null;
  }

  const stats = statSync(entryPath);
  if (stats.isFile()) {
    const name = entryPath.split("/").pop() ?? "";
    if (!entryPath.endsWith(".js")) return null;
    if (
      name === "index.js" ||
      name === "loader.js" ||
      name === "license.js" ||
      name === "contracts.js"
    ) {
      return null;
    }
    return entryPath;
  }

  if (!stats.isDirectory()) {
    return null;
  }

  const packageJsonPath = join(entryPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
        main?: string;
        module?: string;
      };
      const entryFile = packageJson.module ?? packageJson.main ?? "index.js";
      const resolved = resolve(dirname(packageJsonPath), entryFile);
      if (existsSync(resolved) && statSync(resolved).isFile()) {
        return resolved;
      }
      log(
        "warn",
        `Plugin package at ${entryPath} declares missing entry '${entryFile}' — skipping`,
      );
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "entry_missing",
        message: `Plugin package declares missing entry '${entryFile}'`,
        entryPath,
      });
      return null;
    } catch (e) {
      log(
        "warn",
        `Failed to parse plugin package.json at ${packageJsonPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "package_invalid",
        message: e instanceof Error ? e.message : String(e),
        entryPath,
      });
      return null;
    }
  }

  const indexPath = join(entryPath, "index.js");
  if (existsSync(indexPath) && statSync(indexPath).isFile()) {
    return indexPath;
  }

  emitStatus?.({
    type: "plugin_skipped",
    reasonCode: "entry_missing",
    message: "Plugin directory has neither package entrypoint nor index.js",
    entryPath,
  });

  return null;
}

/**
 * Load a single .js file and validate it exports an MCPServerPlugin.
 * Uses dynamic import() for ESM compatibility.
 */
async function loadModule(
  filePath: string,
  baseContext: PluginLoaderContextBase,
): Promise<LoadedPlugin | null> {
  const imported = await import(filePath) as Record<string, unknown>;
  const plugin = extractPlugin(
    imported,
    filePath,
    baseContext.log,
    baseContext.emitStatus,
  );
  if (plugin === null) {
    return null;
  }

  const missingCapabilities = plugin.manifest.requiredCapabilities.filter(
    (capability) => !hasCapability(baseContext.capabilities, capability),
  );
  if (missingCapabilities.length > 0) {
    baseContext.log(
      "warn",
      `Skipping plugin ${plugin.manifest.id}: missing capabilities ${missingCapabilities.join(", ")}`,
    );
    baseContext.emitStatus?.({
      type: "plugin_skipped",
      reasonCode: "capability_missing",
      message: `Missing capabilities: ${missingCapabilities.join(", ")}`,
      entryPath: filePath,
      pluginId: plugin.manifest.id,
    });
    return null;
  }

  const ctx: PluginContext = baseContext;

  if (plugin.initialize) {
    try {
      await plugin.initialize(ctx);
    } catch (e) {
      baseContext.emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "initialize_failed",
        message: e instanceof Error ? e.message : String(e),
        entryPath: filePath,
        pluginId: plugin.manifest.id,
      });
      throw e;
    }
  }

  return {
    manifest: plugin.manifest,
    tools: plugin.tools,
    agent: plugin.agent,
    shutdown: plugin.shutdown ? () => plugin.shutdown!(ctx) : undefined,
  };
}

function extractPlugin(
  mod: Record<string, unknown>,
  filePath: string,
  log: LogFn,
  emitStatus?: (event: StatusEvent) => void,
): MCPServerPlugin | null {
  const rawPlugin = mod.plugin ?? mod.default;

  if (!rawPlugin || typeof rawPlugin !== "object") {
    log("warn", `Plugin at ${filePath} missing default/plugin export — skipping`);
    emitStatus?.({
      type: "plugin_skipped",
      reasonCode: "export_missing",
      message: "Plugin missing default/plugin export",
      entryPath: filePath,
    });
    return null;
  }

  const pluginRecord = rawPlugin as Record<string, unknown>;

  try {
    const manifest = PluginManifestSchema.parse(pluginRecord.manifest);
    const tools = validateTools(
      pluginRecord.tools,
      manifest.id,
      filePath,
      log,
      emitStatus,
    );
    if (tools === null) {
      return null;
    }

    if (manifest.tools.length > 0) {
      const actualToolNames = tools.map((tool) => tool.name);
      const missingDeclaredTools = manifest.tools.filter(
        (toolName) => !actualToolNames.includes(toolName),
      );
      if (missingDeclaredTools.length > 0) {
        log(
          "warn",
          `Plugin '${manifest.id}' declares missing tools: ${missingDeclaredTools.join(", ")} — skipping`,
        );
        emitStatus?.({
          type: "plugin_skipped",
          reasonCode: "tools_invalid",
          message: `Manifest declares missing tools: ${missingDeclaredTools.join(", ")}`,
          entryPath: filePath,
          pluginId: manifest.id,
        });
        return null;
      }
    }

    if (
      pluginRecord.initialize !== undefined &&
      typeof pluginRecord.initialize !== "function"
    ) {
      log("warn", `Plugin '${manifest.id}' at ${filePath} has non-function initialize export — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "manifest_invalid",
        message: "Plugin initialize export must be a function",
        entryPath: filePath,
        pluginId: manifest.id,
      });
      return null;
    }
    if (
      pluginRecord.shutdown !== undefined &&
      typeof pluginRecord.shutdown !== "function"
    ) {
      log("warn", `Plugin '${manifest.id}' at ${filePath} has non-function shutdown export — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "manifest_invalid",
        message: "Plugin shutdown export must be a function",
        entryPath: filePath,
        pluginId: manifest.id,
      });
      return null;
    }

    return {
      manifest,
      initialize: pluginRecord.initialize as MCPServerPlugin["initialize"],
      shutdown: pluginRecord.shutdown as MCPServerPlugin["shutdown"],
      agent: pluginRecord.agent as MCPServerPlugin["agent"],
      tools,
    };
  } catch (e) {
    log(
      "warn",
      `Plugin at ${filePath} has invalid manifest: ${e instanceof Error ? e.message : String(e)}`,
    );
    emitStatus?.({
      type: "plugin_skipped",
      reasonCode: "manifest_invalid",
      message: e instanceof Error ? e.message : String(e),
      entryPath: filePath,
    });
    return null;
  }
}

function validateTools(
  rawTools: unknown,
  pluginId: string,
  filePath: string,
  log: LogFn,
  emitStatus?: (event: StatusEvent) => void,
): ToolModule[] | null {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    log("warn", `Plugin '${pluginId}' at ${filePath} missing tools array — skipping`);
    emitStatus?.({
      type: "plugin_skipped",
      reasonCode: "tools_invalid",
      message: "Plugin missing tools array",
      entryPath: filePath,
      pluginId,
    });
    return null;
  }

  const tools: ToolModule[] = [];
  for (const rawTool of rawTools) {
    if (!rawTool || typeof rawTool !== "object") {
      log("warn", `Plugin '${pluginId}' at ${filePath} contains invalid tool entry — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "tools_invalid",
        message: "Plugin contains invalid tool entry",
        entryPath: filePath,
        pluginId,
      });
      return null;
    }

    const tool = rawTool as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name) {
      log("warn", `Plugin '${pluginId}' at ${filePath} has tool missing 'name' — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "tools_invalid",
        message: "Tool missing name",
        entryPath: filePath,
        pluginId,
      });
      return null;
    }
    if (typeof tool.description !== "string") {
      log("warn", `Plugin '${pluginId}' tool '${tool.name}' missing 'description' — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "tools_invalid",
        message: `Tool '${String(tool.name)}' missing description`,
        entryPath: filePath,
        pluginId,
      });
      return null;
    }
    if (!tool.inputSchema) {
      log("warn", `Plugin '${pluginId}' tool '${tool.name}' missing 'inputSchema' — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "tools_invalid",
        message: `Tool '${String(tool.name)}' missing inputSchema`,
        entryPath: filePath,
        pluginId,
      });
      return null;
    }
    if (typeof tool.createHandler !== "function") {
      log("warn", `Plugin '${pluginId}' tool '${tool.name}' missing 'createHandler' — skipping`);
      emitStatus?.({
        type: "plugin_skipped",
        reasonCode: "tools_invalid",
        message: `Tool '${String(tool.name)}' missing createHandler`,
        entryPath: filePath,
        pluginId,
      });
      return null;
    }

    tools.push({
      name: tool.name as string,
      description: tool.description as string,
      inputSchema: tool.inputSchema,
      createHandler: tool.createHandler as ToolModule["createHandler"],
    });
  }

  return tools;
}
