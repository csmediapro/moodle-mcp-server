import { mkdirSync, appendFileSync } from "node:fs";
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
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";
let toolCallLogPath: string | null = null;
let toolCallLogInitialized = false;

export function initLogging(config: Config): void {
  minLevel = config.logging.level;
  toolCallLogPath = config.logging.toolCallLog;

  // Ensure log directory exists
  if (toolCallLogPath) {
    const dir = dirname(toolCallLogPath);
    mkdirSync(dir, { recursive: true });
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

  // Lazy-init on first call
  if (!toolCallLogInitialized) {
    toolCallLogInitialized = true;
  }

  const fullEntry: ToolCallLogEntry = {
    event: "tool_call",
    ts: new Date().toISOString(),
    ...entry,
  };

  try {
    appendFileSync(toolCallLogPath, JSON.stringify(fullEntry) + "\n");
  } catch (e) {
    logger.warn(
      "Failed to write tool-call log",
      { error: e instanceof Error ? e.message : String(e) }
    );
  }
}
