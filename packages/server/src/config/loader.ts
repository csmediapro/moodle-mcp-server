import { Config, ConfigSchema } from "./schema.js";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  accessSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

type MutableConfigObject = Record<string, unknown>;

export class ConfigLoadError extends Error {
  public readonly code: "config_invalid" | "config_unwritable";

  constructor(code: "config_invalid" | "config_unwritable", message: string) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = code;
  }
}

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
  const configPath = resolveConfigPath();

  // Load config from disk if it exists
  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    } catch (e) {
      throw new ConfigLoadError(
        "config_invalid",
        `Failed to parse config.json at ${configPath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else {
    console.warn(
      `No config.json found at ${configPath}. Using schema defaults + env overrides.`
    );
  }

  const configWithIdentity = ensureServerId(raw, configPath);

  // Apply environment variable overrides with dot-path notation
  // e.g., MOODLE_URL -> moodle.url, LOGGING_LEVEL -> logging.level
  const overrides = applyEnvOverrides(configWithIdentity);

  // Validate against schema
  const result = ConfigSchema.safeParse(overrides);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigLoadError(
      "config_invalid",
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
    SERVER_ID: ["server", "id"],
    SERVER_NAME: ["server", "name"],
    SERVER_VERSION: ["server", "version"],
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

function ensureServerId(raw: unknown, configPath: string): unknown {
  const cfg = cloneAsConfigObject(raw);
  const envServerId = process.env.SERVER_ID?.trim();
  if (envServerId) {
    return cfg;
  }

  const existingId = readNestedString(cfg, ["server", "id"]);
  if (existingId) {
    return cfg;
  }

  assertConfigPathWritable(configPath);

  const generatedId = generateServerId();
  setNestedValue(cfg, ["server", "id"], generatedId);
  persistConfig(configPath, cfg);

  console.warn(
    `Generated persistent server.id ${generatedId} and wrote it to ${configPath}`
  );

  return cfg;
}

function cloneAsConfigObject(raw: unknown): MutableConfigObject {
  if (typeof raw === "object" && raw !== null) {
    return JSON.parse(JSON.stringify(raw)) as MutableConfigObject;
  }
  return {};
}

function readNestedString(
  cfg: MutableConfigObject,
  path: string[]
): string | undefined {
  let current: unknown = cfg;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current : undefined;
}

function setNestedValue(
  cfg: MutableConfigObject,
  path: string[],
  value: unknown
): void {
  let current: MutableConfigObject = cfg;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = current[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as MutableConfigObject;
  }
  current[path[path.length - 1]] = value;
}

function assertConfigPathWritable(configPath: string): void {
  const target = existsSync(configPath) ? configPath : dirname(configPath);

  try {
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }
    accessSync(target, constants.W_OK);
  } catch (e) {
    throw new ConfigLoadError(
      "config_unwritable",
      `server.id is missing and config path is not writable: ${configPath}. ` +
        `The core must persist a stable server.id. Fix permissions or set a writable config path. ` +
        `Details: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export function persistConfig(configPath: string, cfg: MutableConfigObject): void {
  try {
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  } catch (e) {
    throw new ConfigLoadError(
      "config_unwritable",
      `Failed to persist config to ${configPath}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

function generateServerId(): string {
  let suffix = "";
  while (suffix.length < 8) {
    suffix += Math.random().toString(36).slice(2);
  }
  return `mcp_${suffix.slice(0, 8)}`;
}

export function resolveConfigPath(): string {
  const configuredPath = process.env.MOODLE_MCP_CONFIG ?? process.env.MOODLE_MCP_SERVER_CONFIG;
  if (configuredPath && configuredPath.trim()) {
    return resolve(configuredPath.trim());
  }
  return resolve(process.cwd(), "config.json");
}

export function resolvePluginSearchPaths(
  searchPaths: Config["plugins"]["searchPaths"],
  configPath = resolveConfigPath()
): Config["plugins"]["searchPaths"] {
  const configDir = dirname(configPath);

  return searchPaths.map((searchPath) => ({
    ...searchPath,
    path: isAbsolute(searchPath.path)
      ? searchPath.path
      : resolve(configDir, searchPath.path),
  }));
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
