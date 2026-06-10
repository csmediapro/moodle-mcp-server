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

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal("1"),
  description: z.string().default(""),
  requiredCapabilities: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type AgentCaptureTransform = "filterKey" | "filterValue" | "number";

export interface AgentArgCapture {
  kind: "arg";
  name: string;
  group: string | number;
  transform?: AgentCaptureTransform;
}

export interface AgentFilterCapture {
  kind: "filter";
  target: string;
  fieldGroup: string | number;
  valueGroup: string | number;
  fieldTransform?: AgentCaptureTransform;
  valueTransform?: AgentCaptureTransform;
}

export type AgentCapture = AgentArgCapture | AgentFilterCapture;

export interface AgentIntentRoute {
  id: string;
  description?: string;
  match: string;
  flags?: string;
  tool: string;
  args?: Record<string, unknown>;
  captures?: AgentCapture[];
  exclude?: string[];
}

export interface AgentToolRewrite {
  id: string;
  description?: string;
  whenTool: string;
  match: string;
  flags?: string;
  tool: string;
  args?: Record<string, unknown>;
  captures?: AgentCapture[];
  exclude?: string[];
}

export interface AgentContinuationAction {
  tool: string;
  keywords: string[];
}

export interface AgentRegistration {
  promptRules?: string[];
  intentRoutes?: AgentIntentRoute[];
  toolRewrites?: AgentToolRewrite[];
  continuationActions?: AgentContinuationAction[];
}

export interface PluginContext {
  moodleClient: MoodleClient;
  capabilities: MoodleCapabilities;
  log: LogFn;
  config: {
    serverName: string;
    serverVersion: string;
  };
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
  agent?: AgentRegistration;
  tools: ToolModule[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  tools: ToolModule[];
  agent?: AgentRegistration;
  shutdown?: () => Promise<void> | void;
}

export interface PluginSearchPath {
  path: string;
}
