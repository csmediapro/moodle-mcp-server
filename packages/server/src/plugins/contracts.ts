import { z } from "zod";
import type { MoodleClient } from "../moodle/client.js";
import type { MoodleCapabilities } from "../moodle/capabilities.js";
import type { LogFn } from "../server/factory.js";
export type {
  ToolColumn,
  ToolContextBlock,
  ToolDataBlock,
  ToolEntity,
  ToolEntityAction,
  ToolEntityRef,
  ToolInteractionAction,
  ToolInteractionsBlock,
  ToolPresentation,
  ToolResponse,
} from "../tools/response-types.js";

export const LicenseResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("valid"),
    tier: z.string(),
    featuresEnabled: z.array(z.string()).default([]),
    identity: z.string().optional(),
    expiresAt: z.string().optional(),
  }),
  z.object({
    status: z.literal("invalid"),
    reason: z.string(),
    featuresEnabled: z.array(z.string()).default([]),
  }),
  z.object({
    status: z.literal("missing"),
    reason: z.string(),
    featuresEnabled: z.array(z.string()).default([]),
  }),
]);

export type LicenseResult = z.infer<typeof LicenseResultSchema>;

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal("1"),
  description: z.string().default(""),
  requiresLicense: z.boolean().default(false),
  requiredCapabilities: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface PluginContext {
  moodleClient: MoodleClient;
  capabilities: MoodleCapabilities;
  log: LogFn;
  config: {
    serverName: string;
    serverVersion: string;
  };
  license: LicenseResult;
}

export interface ToolModule {
  name: string;
  description: string;
  inputSchema: unknown;
  createHandler: (
    ctx: PluginContext,
  ) => (args: unknown) => Promise<unknown>;
}

export interface MCPServerPlugin {
  manifest: PluginManifest;
  initialize?: (ctx: PluginContext) => Promise<void> | void;
  shutdown?: (ctx: PluginContext) => Promise<void> | void;
  tools: ToolModule[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  license: LicenseResult;
  tools: ToolModule[];
  shutdown?: () => Promise<void> | void;
}

export interface PluginSearchPath {
  path: string;
  requiresLicense: boolean;
}
