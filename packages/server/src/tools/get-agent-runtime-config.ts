import { z } from "zod";
import type { AgentRegistration } from "../plugins/contracts.js";

export const name = "get_agent_runtime_config";

export const description =
  "Internal client configuration tool. Returns declarative agent routing, prompt, rewrite, and continuation rules registered by core and loaded plugins.";

export const inputSchema = z.object({});

export interface AgentRuntimeConfig extends Required<AgentRegistration> {
  plugins: Array<{
    id: string;
    name: string;
    version: string;
  }>;
}

export function emptyAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    promptRules: [],
    intentRoutes: [],
    toolRewrites: [],
    continuationActions: [],
    plugins: [],
  };
}

export function createHandler(getRuntimeConfig: () => AgentRuntimeConfig) {
  return async (args: unknown) => {
    inputSchema.parse(args ?? {});
    return getRuntimeConfig();
  };
}
