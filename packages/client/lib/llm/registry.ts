import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLMProvider } from "./types";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAICompatibleProvider } from "./openai-compatible";

export interface ProviderConfig {
  type: "anthropic" | "openai-compatible";
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  enabled?: boolean;
}

export interface ClientConfig {
  llm: {
    active: string;
    providers: Record<string, ProviderConfig>;
  };
  mcp: {
    serverCommand: string;
    serverArgs: string[];
    serverCwd?: string;
  };
}

let configCache: ClientConfig | null = null;

export function getClientConfig(): ClientConfig {
  if (configCache) return configCache;

  const configPath = resolve(process.cwd(), "config.json");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(
      `Failed to read client config at ${configPath}. Copy config.example.json to config.json.`
    );
  }

  configCache = raw as ClientConfig;
  return configCache;
}

export function getActiveProviderKey(): string {
  return getClientConfig().llm.active;
}

export function getProvider(key?: string, modelOverride?: string): LLMProvider {
  const config = getClientConfig();
  const targetKey = key || config.llm.active;
  const providerCfg = config.llm.providers[targetKey];

  if (!providerCfg || providerCfg.enabled === false) {
    const available = Object.entries(config.llm.providers)
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([providerKey]) => providerKey)
      .join(", ");
    throw new Error(
      `Provider "${targetKey}" not found. Available: ${available || "none"}`
    );
  }

  const apiKey = providerCfg.apiKeyEnv
    ? process.env[providerCfg.apiKeyEnv] || ""
    : "";

  if (providerCfg.apiKeyEnv && !apiKey) {
    throw new Error(
      `Provider "${targetKey}" requires env var ${providerCfg.apiKeyEnv}.`
    );
  }

  return createProvider(providerCfg, apiKey, modelOverride || providerCfg.defaultModel);
}

function createProvider(
  cfg: ProviderConfig,
  apiKey: string,
  model: string
): LLMProvider {
  switch (cfg.type) {
    case "anthropic":
      return createAnthropicProvider({
        baseUrl: cfg.baseUrl,
        model,
        apiKey,
        displayName: cfg.label,
      });

    case "openai-compatible":
      return createOpenAICompatibleProvider({
        baseUrl: cfg.baseUrl,
        model,
        apiKey,
        displayName: cfg.label,
      });

    default:
      throw new Error(`Unknown provider type: ${(cfg as { type: string }).type}`);
  }
}
