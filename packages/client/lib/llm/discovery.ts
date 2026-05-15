import { getClientConfig, ProviderConfig } from "./registry";

export interface DiscoveredProvider {
  key: string;
  label: string;
  models: string[];
  defaultModel: string;
  contextWindow: number;
  modelContextWindows?: Record<string, number>;
}

export interface ProvidersResponse {
  providers: DiscoveredProvider[];
  activeProvider: string;
  activeModel: string;
}

let cache: ProvidersResponse | null = null;

export async function discoverProviders(): Promise<ProvidersResponse> {
  if (cache) return cache;

  const config = getClientConfig();
  const providerEntries = Object.entries(config.llm.providers)
    .filter(([, provider]) => provider.enabled !== false);

  const discovered = await Promise.all(
    providerEntries.map(([key, provider]) => discoverProvider(key, provider))
  );

  const availableProviders = discovered.filter(
    (provider): provider is DiscoveredProvider => provider !== null
  );

  if (availableProviders.length === 0) {
    throw new Error(
      "No available providers discovered. Check API keys and local model endpoints."
    );
  }

  const activeProvider = availableProviders.find(
    (provider) => provider.key === config.llm.active
  ) || availableProviders[0];

  cache = {
    providers: availableProviders,
    activeProvider: activeProvider.key,
    activeModel: activeProvider.defaultModel,
  };

  return cache;
}

async function discoverProvider(
  key: string,
  provider: ProviderConfig
): Promise<DiscoveredProvider | null> {
  const apiKey = provider.apiKeyEnv
    ? process.env[provider.apiKeyEnv] || ""
    : "";

  if (provider.apiKeyEnv && !apiKey) {
    console.warn(
      `[providers] Provider "${key}" requires env var ${provider.apiKeyEnv} — skipping`
    );
    return null;
  }

  try {
    const models = filterDiscoveredModels(
      key,
      await probeModels(provider, apiKey)
    );
    if (models.length === 0) {
      console.warn(`[providers] Provider "${key}" returned no models — skipping`);
      return null;
    }

    const defaultModel = models.includes(provider.defaultModel)
      ? provider.defaultModel
      : models[0];

    console.warn(
      `[providers] Discovered provider: ${key} → ${models.length} model(s), default ${defaultModel}`
    );

    return {
      key,
      label: provider.label,
      models,
      defaultModel,
      contextWindow: provider.contextWindow ?? 131072,
      ...(provider.modelContextWindows ? { modelContextWindows: provider.modelContextWindows } : {}),
    };
  } catch (error) {
    console.warn(
      `[providers] Probe failed for ${key}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function probeModels(
  provider: ProviderConfig,
  apiKey: string
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    provider.label.includes("llama.cpp") ? 1200 : 3000
  );

  try {
    if (provider.type === "anthropic") {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/models`, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body = (await res.json()) as {
        data?: Array<{ id?: string }>;
      };

      return dedupe(body.data?.map((model) => model.id).filter(Boolean) as string[]);
    }

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ id?: string; model?: string; name?: string }>;
    };

    return dedupe([
      ...((body.data?.map((model) => model.id).filter(Boolean) as string[]) ?? []),
      ...((body.models
        ?.map((model) => model.id || model.model || model.name)
        .filter(Boolean) as string[]) ?? []),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function dedupe(models: string[]): string[] {
  return Array.from(new Set(models));
}

function filterDiscoveredModels(key: string, models: string[]): string[] {
  if (key !== "openai") {
    return models;
  }

  return models.filter(isOpenAIChatSafeModel);
}

function isOpenAIChatSafeModel(model: string): boolean {
  const lower = model.toLowerCase();

  const blockedSubstrings = [
    "embedding",
    "embed",
    "whisper",
    "tts",
    "audio",
    "realtime",
    "moderation",
    "image",
    "transcribe",
    "transcription",
    "search-preview",
    "search-api",
    "codex",
    "instruct",
    "davinci",
    "babbage",
    "sora",
  ];

  if (blockedSubstrings.some((part) => lower.includes(part))) {
    return false;
  }

  return (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower === "chat-latest"
  );
}
