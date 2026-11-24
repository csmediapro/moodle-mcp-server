import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Config } from "../config/schema.js";

/**
 * Structured logger for the MCP server.
 *
 * IMPORTANT: this server can run over stdio transport.
 * Stdout is reserved for the MCP JSON-RPC stream and must never be used for logs.
 * Write logs to stderr (or files) only.
 *
 * Tool-call logs are the primary data source for v2 tool design.
 * Every call records: tool name, args, success/failure, duration, result size.
 *
 * Logs are written as JSONL to a file, one line per event.
 *
 * Security: the tool-call log directory is created 0700 and the log
 * file is created 0600 so partially-masked learner search values are
 * never world-readable on shared hosts. A size-based retention cap
 * truncates the oldest lines when the file exceeds the configured
 * maximum, so the log cannot grow without bound.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Default retention cap for the tool-call log: 20 MiB. */
const DEFAULT_TOOL_CALL_LOG_MAX_BYTES = 20 * 1024 * 1024;

let minLevel: LogLevel = "info";
let toolCallLogPath: string | null = null;
let toolCallLogMaxBytes: number = DEFAULT_TOOL_CALL_LOG_MAX_BYTES;
let toolCallLogInitialized = false;

export function initLogging(config: Config): void {
  minLevel = config.logging.level;
  toolCallLogPath = config.logging.toolCallLog;
  toolCallLogMaxBytes =
    config.logging.toolCallLogMaxBytes ?? DEFAULT_TOOL_CALL_LOG_MAX_BYTES;

  // Ensure log directory exists with owner-only permissions so the
  // tool-call log (which contains partially-masked search values)
  // is not world-readable on shared hosts.
  if (toolCallLogPath) {
    const dir = dirname(toolCallLogPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir mode is masked by umask; enforce explicitly for the leaf dir
    // (best effort — non-root may not chmod a dir it does not own,
    //  but the service user creates it here, so it does).
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort only
    }
  }
}

export function log(level: LogLevel, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(data !== undefined ? { data } : {}),
  };

  const line = JSON.stringify(entry);
  process.stderr.write(line + "\n");
}

export const logger = {
  debug(message: string, data?: unknown): void {
    log("debug", message, data);
  },
  info(message: string, data?: unknown): void {
    log("info", message, data);
  },
  warn(message: string, data?: unknown): void {
    log("warn", message, data);
  },
  error(message: string, data?: unknown): void {
    log("error", message, data);
  },
};

export type StatusEvent =
  | {
      type: "startup_begin";
      serverName: string;
      serverVersion: string;
    }
  | {
      type: "config_loaded";
      configPath: string;
      serverId: string;
      serverName: string;
      serverVersion: string;
    }
  | {
      type: "identity_ready";
      serverId: string;
      serverName: string;
      serverVersion: string;
    }
  | {
      type: "token_loaded";
    }
  | {
      type: "moodle_probe_begin";
      moodleUrl: string;
    }
  | {
      type: "moodle_probe_ok";
      capabilityCount: number;
    }
  | {
      type: "moodle_probe_failed";
      code: "moodle_unreachable" | "capability_probe_failed";
      stage: "moodle_probe";
      message: string;
    }
  | {
      type: "cache_warm_ok";
    }
  | {
      type: "cache_warm_failed";
      reason: string;
    }
  | {
      type: "plugin_loaded";
      pluginId: string;
      pluginVersion: string;
      entryPath: string;
      toolCount: number;
    }
  | {
      type: "plugin_skipped";
      reasonCode:
        | "path_missing"
        | "package_invalid"
        | "entry_missing"
        | "load_failed"
        | "export_missing"
        | "manifest_invalid"
        | "tools_invalid"
        | "capability_missing"
        | "initialize_failed";
      message: string;
      entryPath?: string;
      pluginId?: string;
    }
  | {
      type: "ready";
      toolCount: number;
      pluginCount: number;
    }
  | {
      type: "shutdown_begin";
      signal: string;
    }
  | {
      type: "fatal";
      code:
        | "config_invalid"
        | "config_unwritable"
        | "token_missing"
        | "moodle_unreachable"
        | "capability_probe_failed"
        | "plugin_load_failed"
        | "server_start_failed";
      stage:
        | "config"
        | "token"
        | "moodle_probe"
        | "plugins"
        | "server_connect"
        | "startup";
      message: string;
    };

export function emitStatus(event: StatusEvent): void {
  const entry = {
    ts: new Date().toISOString(),
    stream: "status",
    ...event,
  };

  process.stderr.write(JSON.stringify(entry) + "\n");
}

/**
 * Log a tool invocation with timing and outcome.
 * This is the primary telemetry that feeds v2 tool design.
 */
export interface ToolCallLogEntry {
  event: "tool_call";
  tool: string;
  args: unknown;
  success: boolean;
  durationMs: number;
  resultSize?: number;
  error?: string;
  ts: string;
}

export function logToolCall(entry: Omit<ToolCallLogEntry, "event" | "ts">): void {
  if (!toolCallLogPath) return;

  const fullEntry: ToolCallLogEntry = {
    event: "tool_call",
    ts: new Date().toISOString(),
    ...entry,
  };

  const line = JSON.stringify(fullEntry) + "\n";

  try {
    // First write in this process: create the file owner-only.
    if (!toolCallLogInitialized) {
      const fd = openSync(toolCallLogPath, "a");
      try {
        chmodSync(toolCallLogPath, 0o600);
      } finally {
        closeSync(fd);
      }
      toolCallLogInitialized = true;
    }

    // Size-based retention: when the log exceeds the configured cap,
    // drop the oldest complete lines instead of growing without bound.
    // Retention keeps whole JSONL lines only; a partial first line is
    // discarded rather than left corrupt.
    try {
      const size = statSync(toolCallLogPath).size;
      if (size + line.length > toolCallLogMaxBytes && size > 0) {
        trimLogToBudget(toolCallLogPath, Math.max(0, toolCallLogMaxBytes - line.length));
      }
    } catch {
      // stat failed (e.g. file removed mid-flight) — proceed with append
    }

    appendFileSync(toolCallLogPath, line);
  } catch (e) {
    logger.warn(
      "Failed to write tool-call log",
      { error: e instanceof Error ? e.message : String(e) }
    );
  }
}

/** A telemetry line is worth keeping only if it parses. */
function isParseableJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim the JSONL log to the given byte budget by removing the oldest
 * complete lines. Runs once per overflow, not per line, so a large
 * retained tail does not re-copy the file every write.
 */
function trimLogToBudget(path: string, budgetBytes: number): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  // Last element after a trailing newline is always "" — keep that shape.
  let retained = lines.length;
  let retainedBytes = Buffer.byteLength(content, "utf8");

  while (retainedBytes > budgetBytes && retained > 1) {
    retainedBytes -= Buffer.byteLength(lines[0] + "\n", "utf8");
    retained -= 1;
    lines.shift();
  }

  // A crash mid-write can leave a partial line that later appends
  // concatenate onto, producing an unparseable line. Corrupt telemetry
  // is worthless; drop leading lines that do not parse as JSON.
  while (lines.length > 0 && lines[0] !== "" && !isParseableJsonLine(lines[0])) {
    lines.shift();
  }

  try {
    writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  } catch {
    // Retention is best effort; append proceeds with current file.
  }
}
