"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { formatToolResultForLLM } from "@/lib/tool-result";
import { ToolResultView, isStructuredToolResult } from "@/components/tool-results/ToolResultView";
import { Database } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallBlock[];
  isStreaming?: boolean;
  /** Hide from the chat render — still participates in history reconstruction */
  hidden?: boolean;
}

interface ToolCallBlock {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  historyResult?: string;
  loading?: boolean;
  error?: string;
}

interface ProviderInfo {
  key: string;
  label: string;
  models: string[];
  defaultModel: string;
  contextWindow: number;
  modelContextWindows?: Record<string, number>;
}

// ─── localStorage keys ────────────────────────────────────────────────────

const LS_PROVIDER = "moodle_mcp_provider";
const LS_MODEL = "moodle_mcp_model";

type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "done"; stopReason: string; usage?: { promptTokens: number; completionTokens: number } };

function createClientId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }

  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ─── Page Component ───────────────────────────────────────────────────────

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeProvider, setActiveProvider] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [siteStatus, setSiteStatus] = useState<{
    serverName?: string;
    siteName?: string;
    release?: string;
    version?: string;
    username?: string;
    functionCount?: number;
    courseCount?: number;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [providersLoading, setProvidersLoading] = useState(true);
  const welcomeFired = useRef(false);
  const [tokenCount, setTokenCount] = useState<{ current: number; max: number } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submitMessage = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || isLoading) return;

    setInput("");
    setError(null);
    localStorage.setItem(LS_PROVIDER, activeProvider);
    localStorage.setItem(LS_MODEL, activeModel);

    const userMsg: ChatMessage = {
      id: createClientId(),
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);

    const assistantId = createClientId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      isStreaming: true,
    };
    setMessages((prev) => [...prev, assistantMsg]);
    setIsLoading(true);

    const history = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
      })),
      toolResults: m.toolCalls?.map((tc) =>
        tc.result
          ? {
              id: tc.id,
              result:
                tc.historyResult ||
                (typeof tc.result === "string"
                  ? tc.result
                  : JSON.stringify(tc.result)),
            }
          : undefined
      ).filter(Boolean),
    })).flatMap((m) => {
      const msgs: Array<{ role: string; content: string; toolCalls?: unknown[]; toolCallId?: string }> = [];
      const isMergedAssistant =
        m.role === "assistant" &&
        m.toolCalls?.length &&
        m.content;

      if (isMergedAssistant) {
        msgs.push({ role: "assistant", content: "", toolCalls: m.toolCalls });
      } else {
        msgs.push({ role: m.role, content: m.content, toolCalls: m.toolCalls });
      }

      if (m.toolResults?.length) {
        for (const tr of m.toolResults) {
          if (tr) {
            msgs.push({
              role: "tool",
              content: tr.result,
              toolCallId: tr.id,
            });
          }
        }
      }

      if (isMergedAssistant && m.content) {
        msgs.push({ role: "assistant", content: m.content });
      }

      return msgs;
    });

    try {
      abortRef.current = new AbortController();

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: history,
          providerKey: activeProvider || undefined,
          model: activeModel || undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;

          try {
            const event: StreamEvent = JSON.parse(json);
            processEvent(event, assistantId, setMessages, setSiteStatus);
            if (event.type === "done") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, isStreaming: false } : m
                )
              );
              if (event.usage) {
                setTokenCount((prev) =>
                  prev ? { ...prev, current: event.usage!.promptTokens } : prev,
                );
              }
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (e) {

      if (e instanceof DOMException && e.name === "AbortError") {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        return;
      }
      const errMsg = e instanceof Error ? e.message : String(e);
      setError(errMsg);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: m.content || `Error: ${errMsg}`, isStreaming: false }
            : m
        )
      );
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [activeModel, activeProvider, isLoading, messages]);

  // Fetch available providers on mount
  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((data: {
        providers: ProviderInfo[];
        activeProvider: string;
        activeModel: string;
        error?: string;
      }) => {
        if (data.error) {
          throw new Error(data.error);
        }
        setProviders(data.providers);
        setProvidersLoading(false);

        // Restore last-used selections if they match available providers
        const savedProvider = localStorage.getItem(LS_PROVIDER);
        const savedModel = localStorage.getItem(LS_MODEL);
        const restoredProvider =
          savedProvider &&
          data.providers.some((p: ProviderInfo) => p.key === savedProvider)
            ? savedProvider
            : data.activeProvider;
        const targetProvider =
          data.providers.find((p: ProviderInfo) => p.key === restoredProvider) ||
          data.providers[0] ||
          null;
        const restoredModel =
          savedModel &&
          targetProvider?.models.includes(savedModel)
            ? savedModel
            : targetProvider?.defaultModel ||
              targetProvider?.models[0] ||
              "";
        setActiveProvider(restoredProvider);
        setActiveModel(restoredModel);

        // Initialize token gauge with the resolved context window
        const resolvedCtxWindow =
          targetProvider?.modelContextWindows?.[restoredModel] ??
          targetProvider?.contextWindow ??
          131072;
        setTokenCount({ current: 0, max: resolvedCtxWindow });
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load provider list")
      );
  }, []);

  // Fetch Moodle site status on mount
  useEffect(() => {
    setStatusLoading(true);
    fetch("/api/status")
      .then((r) => r.json())
      .then((data: {
        ok: boolean;
        serverName?: string;
        siteInfo?: unknown;
        error?: string;
      }) => {
        if (!data.ok || data.error) {
          throw new Error(data.error || "Status check failed");
        }

        const si = (data.siteInfo as { meta?: { siteName?: string }; data?: { record?: Record<string, unknown> }; context?: { metrics?: Record<string, number | boolean | null> } }) || {};
        const record = si.data?.record || {};
        const metrics = si.context?.metrics || {};

        setSiteStatus({
          serverName: data.serverName,
          siteName: (record.siteName as string) || undefined,
          release: (record.release as string) || undefined,
          version: (record.version as string) || undefined,
          username: (record.username as string) || undefined,
          functionCount: typeof metrics.functionCount === "number" ? metrics.functionCount : undefined,
          courseCount: typeof record.courseCount === "number" ? record.courseCount : undefined,
        });
      })
      .catch((e) => {
        console.error("Status check failed:", e instanceof Error ? e.message : String(e));
        setSiteStatus(null);
      })
      .finally(() => setStatusLoading(false));
  }, []);

  const selectedProvider = providers.find((p) => p.key === activeProvider) || null;

  // Fire welcome prompt once providers, model, and site status are all ready
  useEffect(() => {
    if (welcomeFired.current) return;
    if (statusLoading) return;
    if (!activeProvider || !activeModel) return;

    welcomeFired.current = true;

    const welcomeText = `You just connected to the LMS. Call get_site_info to learn about the instance, then introduce yourself briefly as the data analyst. Mention what provider/model you're running on (I'm running on ${selectedProvider?.label || activeProvider} with ${activeModel}), note how many courses and API functions are available, and invite the user to explore. Keep it under 4 sentences.`;

    const assistantId = createClientId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      isStreaming: true,
    };
    // Prepend a synthetic user message so history alternation is
    // correct for strict Jinja templates on the second turn.
    const syntheticUser: ChatMessage = {
      id: createClientId(),
      role: "user",
      content: welcomeText,
      hidden: true,
    };
    setMessages([syntheticUser, assistantMsg]);
    setIsLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: welcomeText,
        history: [],
        providerKey: activeProvider,
        model: activeModel,
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (!json) continue;
            try {
              const event: StreamEvent = JSON.parse(json);
              processEvent(event, assistantId, setMessages, setSiteStatus);
              if (event.type === "done") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, isStreaming: false }
                      : m,
                  ),
                );
                if (event.usage) {
                  setTokenCount((prev) =>
                    prev ? { ...prev, current: event.usage!.promptTokens } : prev,
                  );
                }
              }
            } catch { /* skip */ }
          }
        }
      })

      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${e instanceof Error ? e.message : String(e)}`, isStreaming: false }
              : m,
          ),
        );
      })
      .finally(() => {
        setIsLoading(false);
        abortRef.current = null;
      });
  }, [activeProvider, activeModel, statusLoading, selectedProvider]);

  useEffect(() => {
    if (!selectedProvider) return;

    if (!selectedProvider.models.includes(activeModel)) {
      setActiveModel(selectedProvider.defaultModel || selectedProvider.models[0] || "");
    }

    // Update context window gauge when provider/model changes
    const resolvedCtxWindow =
      selectedProvider.modelContextWindows?.[activeModel] ??
      selectedProvider.contextWindow ??
      131072;
    setTokenCount({ current: 0, max: resolvedCtxWindow });
  }, [selectedProvider, activeModel]);

  // Sync document title with site status
  useEffect(() => {
    if (siteStatus?.serverName) {
      document.title = `MCP Server | ${siteStatus.serverName}`;
    }
  }, [siteStatus?.serverName]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Clean up on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleSend = useCallback(async () => {
    await submitMessage(input);
  }, [input, submitMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleSuggestedQuery = useCallback((query: string) => {
    setInput(query);
  }, []);

  const handleToolAction = useCallback(async (query: string) => {
    await submitMessage(query);
  }, [submitMessage]);

  return (
    <div className="mx-auto flex h-full min-h-screen max-w-5xl flex-col bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/90 px-5 py-4 backdrop-blur shrink-0">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {siteStatus?.serverName || "Moodle MCP Server"}
          </h1>
          <p className="text-xs text-slate-500">
            {`MCP Server | Reference Client`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={activeProvider}
            onChange={(e) => {
              const nextProvider = providers.find((p) => p.key === e.target.value);
              setActiveProvider(e.target.value);
              const nextModel = nextProvider?.defaultModel || nextProvider?.models[0] || "";
              setActiveModel(nextModel);
              localStorage.setItem(LS_PROVIDER, e.target.value);
              localStorage.setItem(LS_MODEL, nextModel);
            }}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 shadow-sm"
            disabled={isLoading}
          >
            {providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            value={activeModel}
            onChange={(e) => {
              setActiveModel(e.target.value);
              localStorage.setItem(LS_MODEL, e.target.value);
            }}
            className="max-w-64 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 shadow-sm"
            disabled={isLoading || !selectedProvider}
          >
            {(selectedProvider?.models || []).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          {tokenCount && tokenCount.max > 0 && (
            <div
              className="relative flex h-6 min-w-[60px] items-center rounded-full border border-slate-200 bg-slate-100 text-[10px] font-semibold shadow-sm"
              title={`${tokenCount.current.toLocaleString()} / ${tokenCount.max.toLocaleString()} tokens`}
            >
              {(() => {
                const pct = Math.min(tokenCount.current / tokenCount.max, 1);
                const color =
                  pct < 0.5
                    ? "bg-emerald-400"
                    : pct < 0.8
                      ? "bg-amber-400"
                      : "bg-rose-400";
                return (
                  <>
                    <div
                      className={`absolute inset-0 rounded-full ${color} opacity-20`}
                    />
                    <div
                      className={`absolute inset-0 rounded-full ${color}`}
                      style={{
                        clipPath: `inset(0 ${(1 - pct) * 100}% 0 0)`,
                      }}
                    />
                    <span className="relative z-10 mx-auto text-slate-600">
                      {Math.round(pct * 100)}%
                    </span>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-6 scrollbar-thin">
        {messages.filter((m) => !m.hidden).length === 0 && (
          <div className="mx-auto mt-20 max-w-xl rounded-3xl border border-slate-200 bg-white px-8 py-10 shadow-sm">
            <div className="text-center mb-6">
              <p className="text-lg font-semibold text-slate-900 mb-2">
                {statusLoading
                  ? "Connecting to LMS…"
                  : siteStatus?.siteName
                    ? siteStatus.siteName
                    : "LMS Analytics"}
              </p>
              <p className="text-sm text-slate-500">
                Ask about courses, users, assignments, or recent activity.
              </p>
            </div>

            {statusLoading ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-300" />
                  <span className="text-sm text-slate-500">
                    {providersLoading ? "Establishing connection…" : "Warming up the AI model…"}
                  </span>
                </div>
              </div>
            ) : siteStatus ? (
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-xs font-medium uppercase tracking-wide text-emerald-600">
                    Connected
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  {siteStatus.release && (
                    <>
                      <span className="text-slate-400">Release</span>
                      <span className="font-medium text-slate-700">{siteStatus.release}</span>
                    </>
                  )}
                  {siteStatus.username && (
                    <>
                      <span className="text-slate-400">User</span>
                      <span className="font-medium text-slate-700">{siteStatus.username}</span>
                    </>
                  )}
                  {siteStatus.courseCount !== undefined && (
                    <>
                      <span className="text-slate-400">Courses</span>
                      <span className="font-medium text-slate-700">{siteStatus.courseCount} total</span>
                    </>
                  )}
                  {siteStatus.functionCount !== undefined && (
                    <>
                      <span className="text-slate-400">API Functions</span>
                      <span className="font-medium text-slate-700">{siteStatus.functionCount} available</span>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-100 bg-amber-50/50 px-5 py-4 text-center">
                <span className="text-sm text-amber-600">
                  Could not reach the LMS — check your API token and server config.
                </span>
              </div>
            )}
          </div>
        )}

        {messages.filter((m) => !m.hidden).map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onUseSuggestedQuery={handleSuggestedQuery}
            onToolAction={handleToolAction}
          />
        ))}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-center text-sm text-red-600 shadow-sm">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 bg-white px-5 py-4 shrink-0">
        <div className="flex gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-sm">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about courses…"
            className="max-h-32 flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            rows={1}
            disabled={isLoading}
          />
          {isLoading ? (
            <button
              onClick={handleCancel}
              className="shrink-0 rounded-xl bg-rose-400 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="shrink-0 rounded-xl bg-blue-400 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────

function MessageBubble({
  message,
  onUseSuggestedQuery,
  onToolAction,
}: {
  message: ChatMessage;
  onUseSuggestedQuery?: (query: string) => void;
  onToolAction?: (query: string) => void;
}) {
  const isUser = message.role === "user";
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
  
  // Collect suggested queries from all completed tool results
  const allSuggestedQueries: string[] = [];
  if (hasToolCalls) {
    for (const tc of message.toolCalls!) {
      const sr = isStructuredToolResult(tc.result) ? tc.result : null;
      if (sr?.context?.suggestedQueries) {
        allSuggestedQueries.push(...sr.context.suggestedQueries);
      }
    }
  }

  // Unique suggested queries
  const uniqueSuggestions = Array.from(new Set(allSuggestedQueries)).slice(0, 5);

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[88%] rounded-2xl bg-blue-400 px-4 py-2.5 text-sm text-white shadow-sm">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-3">
      {/* Tool results — DATA HERO, always expanded, above the fold */}
      {hasToolCalls && (
        <div className="space-y-3">
          {message.toolCalls!.map((tc) => (
            <ToolResultHero key={tc.id} toolCall={tc} onToolAction={onToolAction} />
          ))}
        </div>
      )}

      {/* LLM text + suggested queries — BELOW the data */}
      {message.content && (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
          <div className={`whitespace-pre-wrap break-words text-slate-700 ${message.isStreaming ? "streaming-cursor" : ""}`}>
            {message.content}
          </div>

          {/* Follow-up queries inline below the LLM text */}
          {!message.isStreaming && uniqueSuggestions.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <div className="flex flex-wrap gap-1.5">
                {uniqueSuggestions.map((query) => (
                  <button
                    key={query}
                    type="button"
                    onClick={() => onUseSuggestedQuery?.(query)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] text-slate-500 transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-700"
                  >
                    {query}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tool Result Hero Card ─────────────────────────────────────────────────

function ToolResultHero({
  toolCall,
  onToolAction,
}: {
  toolCall: ToolCallBlock;
  onToolAction?: (query: string) => void;
}) {
  const structuredResult = isStructuredToolResult(toolCall.result) ? toolCall.result : null;

  // Loading state
  if (toolCall.loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs shadow-sm animate-fade-in">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-300" />
          <span className="font-medium text-slate-600">{toolCall.name}</span>
          <span className="text-slate-400">running…</span>
        </div>
      </div>
    );
  }

  // Plain result (not structured)
  if (!structuredResult) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-xs shadow-sm">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {toolCall.name}
        </p>
        {toolCall.result !== undefined ? (
          <pre className="max-h-48 overflow-x-auto rounded-xl border border-slate-100 bg-slate-50 p-3 text-[11px] text-slate-600">
            {typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(toolCall.result, null, 2)}
          </pre>
        ) : null}
        {toolCall.error && (
          <p className="text-red-600">{toolCall.error}</p>
        )}
      </div>
    );
  }

  // Structured result — data-first hero
  const { meta } = structuredResult;
  const hasError = structuredResult.ok === false || structuredResult.error;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm animate-fade-in">
      {/* Header row — tool name + count */}
      <div className="mb-3 flex items-center gap-2">
        <Database className="h-3.5 w-3.5 text-slate-400" />
        <span className="text-[11px] font-medium text-slate-400">
          {toolCall.name}
        </span>
        {meta?.resultCount !== undefined && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
            {meta.resultCount} result{meta.resultCount === 1 ? "" : "s"}
          </span>
        )}
        {hasError && (
          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-500">
            Error
          </span>
        )}
      </div>

      {/* Data block */}
      <ToolResultView result={structuredResult} onAction={onToolAction} />
    </div>
  );
}

// ─── Process SSE Event ─────────────────────────────────────────────────────

function processEvent(
  event: StreamEvent,
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setSiteStatus: React.Dispatch<React.SetStateAction<ChatPage["siteStatus"]>>
) {
  switch (event.type) {
    case "text_delta":
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: m.content + event.text }
            : m
        )
      );
      break;

    case "tool_call":
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                toolCalls: [
                  ...(m.toolCalls || []),
                  {
                    id: event.id,
                    name: event.name,
                    args: event.args,
                    loading: true,
                  },
                ],
              }
            : m
        )
      );
      break;

    case "tool_result":
      // Piggyback on get_site_info to update the global site name in the UI
      if (event.result && typeof event.result === "object") {
        const sr = isStructuredToolResult(event.result) ? event.result : null;
        if (sr?.meta?.tool === "get_site_info" && sr.data?.record) {
          const record = sr.data.record as Record<string, any>;
          if (record.siteName) {
            setSiteStatus((prev) => ({
              ...prev,
              serverName: record.siteName,
              siteName: record.siteName,
            }));
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                toolCalls: m.toolCalls?.map((tc) =>
                  tc.id === event.id
                    ? {
                        ...tc,
                        result: event.result,
                        historyResult: formatToolResultForLLM(event.result),
                        loading: false,
                      }
                    : tc
                ),
              }
            : m
        )
      );
      break;

    case "error":
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, isStreaming: false }
            : m
        )
      );
      break;

    case "done":
      // Already handled in handleSend
      break;
  }
}
