import { z } from "zod";

/**
 * Config schema — versioned contract with operators.
 * Every field here is a deliberate choice; changing this
 * schema is a breaking-change event. Bump server.version accordingly.
 */
export const ConfigSchema = z.object({
  moodle: z.object({
    /** Base URL of the Moodle instance — no trailing slash */
    url: z.string().url(),
    /** "auto" = probe capabilities; future: pin to a specific API version */
    apiVersion: z.enum(["auto"]).default("auto"),
  }),
  server: z.object({
    /** Stable machine identity used by agents, dashboards, and audits; generated once and persisted locally */
    id: z
      .string()
      .regex(/^mcp_[a-z0-9]{8}$/i, "must match mcp_<8 alphanumeric chars>"),
    /** Human-friendly display label surfaced in MCP metadata; operators may set this to any label they want */
    name: z.string().default("Moodle MCP Server"),
    /** Semantic version — bump on breaking changes to config or tool signatures */
    version: z.string().default("0.1.0"),
  }),
  logging: z.object({
    /** Minimum log level: debug, info, warn, error */
    level: z
      .enum(["debug", "info", "warn", "error"])
      .default("info"),
    /** Path to JSONL tool-call log file (relative to CWD) */
    toolCallLog: z.string().default("./logs/tool-calls.jsonl"),
  }),
  plugins: z.object({
    /** Optional license key used to unlock premium plugins when an agent injects entitlements via config */
    licenseKey: z.string().min(1).optional(),
    /** Search paths for plugin tool modules */
    searchPaths: z.array(z.object({
      path: z.string(),
      requiresLicense: z.boolean().default(false),
    })).default([]),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
