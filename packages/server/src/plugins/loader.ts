/**
 * Plugin loader — scans configured search paths for MCP tool modules
 * and loads compliant plugins into the tool registry.
 *
 * Design:
 *   - Filesystem-based: drop a directory of compiled .js files into a
 *     search path, they auto-register on next server start.
 *   - Each plugin is a standalone npm package that builds independently.
 *   - Premium plugins validate a license key before their tools activate.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ToolModule, LogFn } from "../server/factory.js";
import { validateLicense } from "./license.js";

export interface PluginSearchPath {
  /** Filesystem path to scan */
  path: string;
  /** If true, tools in this path require a valid license key */
  requiresLicense: boolean;
}

/**
 * Scan all configured search paths and return loaded ToolModules.
 * Skips files that don't look like tool modules (no .js extension,
 * no createHandler export, etc.).
 */
export async function loadPlugins(
  searchPaths: PluginSearchPath[],
  log: LogFn,
  licenseKey?: string
): Promise<ToolModule[]> {
  const loaded: ToolModule[] = [];

  for (const sp of searchPaths) {
    const absPath = resolve(sp.path);
    if (!existsSync(absPath)) {
      log("debug", `Plugin path not found, skipping: ${absPath}`);
      continue;
    }

    // If license is required and invalid, skip this path entirely
    if (sp.requiresLicense) {
      const licenseResult = validateLicense(licenseKey);
      if (!licenseResult.valid) {
        log("warn", `Skipping licensed plugin path ${absPath}: ${licenseResult.error}`);
        continue;
      }
      log("info", `License validated for ${absPath} (${licenseResult.identity ?? "unknown"})`);
    }

    try {
      const entries = readdirSync(absPath);
      for (const entry of entries) {
        const entryPath = join(absPath, entry);
        // Only load .js files, skip directories and non-js
        if (!entry.endsWith(".js")) continue;
        if (statSync(entryPath).isDirectory()) continue;
        // Skip index files and loader internals
        if (entry === "index.js" || entry === "loader.js" || entry === "license.js") continue;

        try {
          const mod = await loadModule(entryPath, log);
          if (mod) {
            loaded.push(mod);
            log("info", `Plugin loaded: ${mod.name} (${entryPath})`);
          }
        } catch (e) {
          log("warn", `Failed to load plugin ${entryPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      log("warn", `Error scanning plugin path ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return loaded;
}

/**
 * Load a single .js file and validate it exports a ToolModule.
 * Uses dynamic import() for ESM compatibility.
 */
async function loadModule(filePath: string, log: LogFn): Promise<ToolModule | null> {
  const imported = await import(filePath) as Record<string, unknown>;
  return validateModule(imported, filePath, log);
}

function validateModule(
  mod: Record<string, unknown>,
  filePath: string,
  log: LogFn
): ToolModule | null {
  if (typeof mod.name !== "string" || !mod.name) {
    log("warn", `Plugin at ${filePath} missing 'name' — skipping`);
    return null;
  }
  if (typeof mod.description !== "string") {
    log("warn", `Plugin '${mod.name}' at ${filePath} missing 'description' — skipping`);
    return null;
  }
  if (!mod.inputSchema) {
    log("warn", `Plugin '${mod.name}' at ${filePath} missing 'inputSchema' — skipping`);
    return null;
  }
  if (typeof mod.createHandler !== "function") {
    log("warn", `Plugin '${mod.name}' at ${filePath} missing 'createHandler' function — skipping`);
    return null;
  }

  return {
    name: mod.name as string,
    description: mod.description as string,
    inputSchema: mod.inputSchema,
    createHandler: mod.createHandler as ToolModule["createHandler"],
  };
}
