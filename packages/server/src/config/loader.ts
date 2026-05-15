import { Config, ConfigSchema } from "./schema.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads and validates the server configuration.
 *
 * Priority (highest wins):
 *   1. Environment variable overrides (MOODLE_URL, LOGGING_LEVEL, etc.)
 *   2. config.json on disk
 *   3. Schema defaults
 *
 * Fails loudly with a readable error if the config is invalid —
 * no silent fallbacks, no half-broken startup.
 */
export function loadConfig(): Config {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(process.cwd(), "config.json");

  // Load config from disk if it exists
  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    } catch (e) {
      throw new Error(
        `Failed to parse config.json at ${configPath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else {
    console.warn(
      `No config.json found at ${configPath}. Using schema defaults + env overrides.`
    );
  }

  // Apply environment variable overrides with dot-path notation
  // e.g., MOODLE_URL -> moodle.url, LOGGING_LEVEL -> logging.level
  const overrides = applyEnvOverrides(raw);

  // Validate against schema
  const result = ConfigSchema.safeParse(overrides);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Config validation failed:\n${issues}\n\nFix config.json or environment variables and retry.`
    );
  }

  return result.data;
}

/**
 * Merges environment variable overrides into the raw config object.
 * Maps SCREAMING_SNAKE env vars to dot-path config keys:
 *   MOODLE_URL        -> moodle.url
 *   MOODLE_API_VERSION -> moodle.apiVersion
 *   LOGGING_LEVEL     -> logging.level
 *   LOGGING_TOOLCALL_LOG -> logging.toolCallLog
 */
function applyEnvOverrides(raw: unknown): unknown {
  // Start with a deep clone to avoid mutating the original
  const cfg =
    typeof raw === "object" && raw !== null
      ? JSON.parse(JSON.stringify(raw))
      : {};

  const envMappings: Record<string, string[]> = {
    MOODLE_URL: ["moodle", "url"],
    MOODLE_API_VERSION: ["moodle", "apiVersion"],
    LOGGING_LEVEL: ["logging", "level"],
    LOGGING_TOOL_CALL_LOG: ["logging", "toolCallLog"],
  };

  for (const [envKey, path] of Object.entries(envMappings)) {
    const val = process.env[envKey];
    if (val === undefined) continue;

    // Set via nested path
    let target: Record<string, unknown> = cfg;
    for (let i = 0; i < path.length - 1; i++) {
      if (!target[path[i]] || typeof target[path[i]] !== "object") {
        target[path[i]] = {};
      }
      target = target[path[i]] as Record<string, unknown>;
    }
    target[path[path.length - 1]] = val;
  }

  return cfg;
}

/**
 * Reads and returns the MOODLE_TOKEN from the environment.
 * Fails if not set — the token is required for all Moodle API calls.
 */
export function loadToken(): string {
  const token = process.env.MOODLE_TOKEN;
  if (!token || token === "your-moodle-api-token-here") {
    throw new Error(
      "MOODLE_TOKEN is not set. Copy .env.example to .env and fill in your Moodle API token.\n" +
        "Obtain a token: Site administration > Plugins > Web services > Manage tokens"
    );
  }
  return token;
}
