/**
 * Agent Loop - Streaming SSE API Route.
 *
 * This is the reference artifact for future operators building their own clients.
 * It implements the full agent loop: receive user message → call LLM → handle
 * tool calls → stream everything back to the browser as Server-Sent Events.
 *
 * ## Architecture
 *
 * The loop works in two phases interleaved over a single SSE connection:
 *
 * 1. **LLM Phase**: Call the active provider with conversation history + tools.
 *    Stream text deltas and tool calls back to the browser as they arrive.
 *
 * 2. **Tool Phase**: When the provider emits a tool_call, pause the upstream
 *    stream, execute the tool via the MCP server, send the result back to the
 *    provider as a function result message, and resume streaming.
 *
 * This repeats until the provider emits a "done" event with a stop reason
 * that isn't "tool_calls".
 *
 * ## Streaming Protocol
 *
 * The response is `Content-Type: text/event-stream`. Each SSE event is:
 *   data: <JSON>\n\n
 *
 * Event types sent to the browser:
 *   - { type: "text_delta", text: "..." }  - incremental text
 *   - { type: "tool_call", id, name, args } - tool invocation started
 *   - { type: "tool_result", id, result }   - tool invocation completed
 *   - { type: "error", message }            - something went wrong
 *   - { type: "done", stopReason }          - conversation turn complete
 *
 * ## Cancellation
 *
 * If the browser aborts the request (user navigates away or hits cancel),
 * the AbortSignal propagates through to the provider's fetch, canceling
 * the upstream LLM call mid-stream.
 *
 * ## Why POST + ReadableStream, not EventSource
 *
 * EventSource doesn't support POST requests, custom headers, or request bodies.
 * We need POST to send conversation history and config. Instead we use
 * fetch() with a ReadableStream reader in the browser.
 */

import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getClientConfig, getProvider } from "@/lib/llm/registry";
import { logChatEval, logToolEval } from "@/lib/eval-logging";
import { logCompositePattern } from "@/lib/composite-logging";
import { initMCPClient, listTools, callTool } from "@/lib/mcp-client";
import { formatToolResultForLLM } from "@/lib/tool-result";
import type { Message, Tool, LLMProvider } from "@/lib/llm/types";

// Initialize MCP client once at module load
// (Next.js modules persist across requests in dev, once in prod)
let mcpInitialized = false;

function isToolErrorResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === false
  );
}

function isStructuredToolResult(value: unknown): value is {
  ok?: boolean;
  context?: unknown;
  interactions?: unknown;
  data?: { kind?: unknown };
  error?: unknown;
} {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type StructuredAction = {
  label?: string;
  tool: string;
  args?: Record<string, unknown>;
};

function normalizeIntentText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectStructuredActions(result: unknown): StructuredAction[] {
  if (!isRecord(result)) {
    return [];
  }

  const actions: StructuredAction[] = [];
  const addAction = (value: unknown) => {
    if (!isRecord(value) || typeof value.tool !== "string" || !value.tool.trim()) {
      return;
    }

    actions.push({
      tool: value.tool.trim(),
      ...(typeof value.label === "string" && value.label.trim()
        ? { label: value.label.trim() }
        : {}),
      ...(isRecord(value.args) ? { args: value.args } : {}),
    });
  };

  if (isRecord(result.context) && Array.isArray(result.context.entities)) {
    for (const entity of result.context.entities) {
      if (!isRecord(entity) || !Array.isArray(entity.actions)) {
        continue;
      }
      for (const action of entity.actions) {
        addAction(action);
      }
    }
  }

  if (isRecord(result.interactions)) {
    const rawActions =
      result.interactions.mode === "tool_actions"
        ? result.interactions.actions
        : result.interactions.mode === "row_actions"
          ? result.interactions.rowActions
          : null;

    if (Array.isArray(rawActions)) {
      for (const action of rawActions) {
        addAction(action);
      }
    }
  }

  return actions;
}

function actionMatchesUserIntent(userMessage: string, action: StructuredAction): boolean {
  const prompt = normalizeIntentText(userMessage);
  const label = action.label ? normalizeIntentText(action.label) : "";
  const tool = normalizeIntentText(action.tool);

  if (action.tool === "get_user_progress_report") {
    return (
      /\bprogress reports?\b/.test(prompt) ||
      /\bcompletion reports?\b/.test(prompt) ||
      /\b(progress|completion|grade|grades)\b/.test(prompt) ||
      /\breports?\b/.test(prompt)
    );
  }

  if (action.tool === "list_user_courses") {
    return /\b(courses?|enrollments?|enrolled)\b/.test(prompt);
  }

  if (label && prompt.includes(label)) {
    return true;
  }

  const meaningfulToolWords = tool
    .split(" ")
    .filter((word) => !["get", "list", "show", "user", "users", "by", "for"].includes(word));

  return meaningfulToolWords.length > 0 && meaningfulToolWords.every((word) => prompt.includes(word));
}

function hasMatchingContinuationAction(opts: {
  userMessage: string;
  result: unknown;
  availableTools: Tool[];
}): boolean {
  const availableToolNames = new Set(opts.availableTools.map((tool) => tool.name));
  return collectStructuredActions(opts.result).some((action) => (
    availableToolNames.has(action.tool) &&
    action.args !== undefined &&
    actionMatchesUserIntent(opts.userMessage, action)
  ));
}

function wantsFullUserPresentation(userMessage: string): boolean {
  const prompt = normalizeIntentText(userMessage);
  return (
    /\b(detailed?|details?|full|complete|expanded|all fields?|full profile|complete profile|raw)\b/.test(prompt) ||
    /\beverything\b/.test(prompt)
  );
}

function normalizeToolArgsForRequest(opts: {
  toolName: string;
  args: unknown;
  userMessage: string;
}): unknown {
  if (opts.toolName !== "get_user" || !isRecord(opts.args)) {
    return opts.args;
  }

  return {
    ...opts.args,
    presentation: wantsFullUserPresentation(opts.userMessage) ? "full" : "compact",
  };
}

type ProviderTurnResult = {
  assistantText: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
  }>;
  stopReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  hadError: boolean;
  errorMessage: string | null;
  textStarted: boolean;
  toolCallStarted: boolean;
};

async function runProviderTurn(opts: {
  provider: LLMProvider;
  messages: Message[];
  tools: Tool[];
  signal: AbortSignal;
  send: (event: Record<string, unknown>) => void;
  onTextDelta?: () => void;
  onToolCall?: () => void;
  normalizeToolCall?: (toolCall: {
    id: string;
    name: string;
    args: unknown;
  }) => {
    id: string;
    name: string;
    args: unknown;
  };
}): Promise<ProviderTurnResult> {
  const toolCalls: ProviderTurnResult["toolCalls"] = [];
  let assistantText = "";
  let stopReason = "";
  let usage: ProviderTurnResult["usage"];
  let hadError = false;
  let errorMessage: string | null = null;
  let textStarted = false;
  let toolCallStarted = false;

  const events = opts.provider.generate({
    messages: opts.messages,
    tools: opts.tools,
    signal: opts.signal,
  });

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        textStarted = true;
        assistantText += event.text;
        opts.onTextDelta?.();
        opts.send({ type: "text_delta", text: event.text });
        break;

      case "tool_call":
        toolCallStarted = true;
        opts.onToolCall?.();
        const toolCall = opts.normalizeToolCall?.({
          id: event.id,
          name: event.name,
          args: event.args,
        }) ?? {
          id: event.id,
          name: event.name,
          args: event.args,
        };
        toolCalls.push(toolCall);
        opts.send({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
        });
        break;

      case "error":
        opts.send({ type: "error", message: event.message });
        stopReason = "error";
        hadError = true;
        errorMessage = event.message;
        break;

      case "done":
        stopReason = event.stopReason;
        usage = event.usage;
        break;
    }
  }

  return {
    assistantText,
    toolCalls,
    stopReason,
    usage,
    hadError,
    errorMessage,
    textStarted,
    toolCallStarted,
  };
}

function shouldFinalizeAfterToolResult(opts: {
  userMessage: string;
  availableTools: Tool[];
  toolCallsFromThisTurn: Array<{ id: string; name: string; args: unknown }>;
  toolResults: unknown[];
}): boolean {
  if (opts.toolCallsFromThisTurn.length !== 1 || opts.toolResults.length !== 1) {
    return false;
  }

  const result = opts.toolResults[0];
  if (!isStructuredToolResult(result) || result.ok === false || result.error) {
    return false;
  }

  const kind = result.data?.kind;
  if (kind !== "table" && kind !== "record" && kind !== "list") {
    return false;
  }

  if (hasMatchingContinuationAction({
    userMessage: opts.userMessage,
    result,
    availableTools: opts.availableTools,
  })) {
    return false;
  }

  const prompt = opts.userMessage.trim().toLocaleLowerCase();
  const directDisplayPatterns = [
    /^(list|show|display|get)\b/,
    /\bfirst\s+\d+\b/,
    /\ball\b/,
    /\bsub categories?\b/,
    /\bchildren\b/,
    /\bunder\b/,
    /\binside\b/,
    /\bcourses?\b/,
    /\bcategories?\b/,
    /\busers?\b/,
    /\bassignments?\b/,
    /\bactivity\b/,
    /\bcompletion\b/,
    /\bdetails?\b/,
  ];

  return directDisplayPatterns.some((pattern) => pattern.test(prompt));
}

function buildFinalSummaryMessages(currentMessages: Message[]): Message[] {
  return [
    ...currentMessages,
    {
      role: "system",
      content:
        "Write a concise final response based on the latest tool result. " +
        "Do not request or imply any additional tool calls. " +
        "The UI already renders the full data, so summarize the result in 1-3 sentences without recreating the table or record.",
    },
  ];
}

async function ensureMCPReady() {
  if (mcpInitialized) return;

  const configPath = resolve(process.cwd(), "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    mcp: { serverCommand: string; serverArgs: string[]; serverCwd?: string };
  };

  await initMCPClient(config.mcp);
  mcpInitialized = true;
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  // Create a ReadableStream for the SSE response
  const stream = new ReadableStream({
    async start(controller) {
      const abortController = new AbortController();
      let streamClosed = false;

      // Use request.signal to detect client disconnect
      const closeController = () => {
        if (!streamClosed) {
          streamClosed = true;
          abortController.abort();
          try { controller.close(); } catch { /* already closed */ }
        }
      };
      request.signal.addEventListener("abort", closeController);

      /** Send an SSE event to the browser */
      function send(event: Record<string, unknown>) {
        if (streamClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          closeController();
        }
      }

      let body: {
        message: string;
        history?: Message[];
        providerKey?: string;
        model?: string;
        sessionId?: string;
        promptCategory?: string;
      } | null = null;
      let providerKey = "unknown";
      let model = "unknown";
      let requestId = crypto.randomUUID();
      let sessionId = "unknown";
      let promptCategory = "unknown";
      let requestStart = Date.now();
      let timeToFirstTokenMs: number | null = null;
      let timeToFirstToolCallMs: number | null = null;
      let toolCallsAttempted = 0;
      let toolCallsSucceeded = 0;
      let toolCallsFailed = 0;
      let toolCallsTimedOut = 0;
      let completed = false;
      let hadError = false;
      let errorMessage: string | null = null;
      let finalStopReason: string | null = null;
      let fullAssistantText = "";
      // Accumulate the most recent usage from done events across iterations
      let lastPromptTokens: number | null = null;
      let lastCompletionTokens: number | null = null;
      let tools: Tool[] = [];

      try {
        // Parse the request body
        body = (await request.json()) as {
          message: string;
          history?: Message[];
          providerKey?: string;
          model?: string;
          sessionId?: string;
          promptCategory?: string;
        };

        const clientConfig = getClientConfig();
        providerKey = body.providerKey || clientConfig.llm.active;
        const providerCfg = clientConfig.llm.providers[providerKey];
        model = body.model || providerCfg?.defaultModel || "unknown";
        requestId = crypto.randomUUID();
        sessionId = body.sessionId || "unknown";
        promptCategory = body.promptCategory || "unknown";
        requestStart = Date.now();
        const userMessage = body.message;

        // Initialize MCP server connection
        await ensureMCPReady();
        tools = listTools();

        // Get the active provider (or the requested one)
        const provider = getProvider(providerKey, model);

        // Build conversation history
        const systemPrompt = buildSystemPrompt(tools, provider.name);
        const historyMsgs = (body.history || []).filter((m) => m.role !== "system") as unknown as Message[];
        
        // Avoid duplicate user message — the browser may include the current
        // message in history, and we'd otherwise append it again.
        const lastHistoryMsg = historyMsgs[historyMsgs.length - 1];
        const alreadyInHistory =
          lastHistoryMsg &&
          lastHistoryMsg.role === "user" &&
          lastHistoryMsg.content === userMessage;

        const messages: Message[] = [
          { role: "system", content: systemPrompt },
        ];
        for (const m of historyMsgs) messages.push(m);
        if (!alreadyInHistory) messages.push({ role: "user", content: userMessage });

        // Run the agent loop
        let maxIterations = 10; // Safety limit - prevent infinite loops
        let currentMessages = [...messages];

        while (maxIterations > 0) {
          maxIterations--;

          // Phase 1: Call the LLM provider
          const turn = await runProviderTurn({
            provider,
            messages: currentMessages,
            tools,
            signal: abortController.signal,
            send,
            onTextDelta: () => {
              if (timeToFirstTokenMs === null) {
                timeToFirstTokenMs = Date.now() - requestStart;
              }
            },
            onToolCall: () => {
              if (timeToFirstToolCallMs === null) {
                timeToFirstToolCallMs = Date.now() - requestStart;
              }
            },
            normalizeToolCall: (toolCall) => ({
              ...toolCall,
              args: normalizeToolArgsForRequest({
                toolName: toolCall.name,
                args: toolCall.args,
                userMessage,
              }),
            }),
          });

          const toolCallsThisTurn = turn.toolCalls.map((tc) => ({
            ...tc,
            args: normalizeToolArgsForRequest({
              toolName: tc.name,
              args: tc.args,
              userMessage,
            }),
          }));

          toolCallsAttempted += toolCallsThisTurn.length;
          fullAssistantText += turn.assistantText;
          finalStopReason = turn.stopReason;
          completed = true;
          if (turn.usage) {
            lastPromptTokens = turn.usage.promptTokens;
            lastCompletionTokens = turn.usage.completionTokens;
          }
          if (turn.hadError) {
            hadError = true;
            errorMessage = turn.errorMessage;
          }

          // If the provider finished without tool calls, we're done
          if (toolCallsThisTurn.length === 0 || turn.stopReason === "error") {
            break;
          }

          // Add the assistant message with tool calls to history
          currentMessages.push({
            role: "assistant",
            content: turn.assistantText || null as unknown as string,
            toolCalls: toolCallsThisTurn.map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: tc.args,
            })),
          });

          // Phase 2: Execute tool calls and add results
          let toolFailureThisTurn = false;
          const toolResultsThisTurn: unknown[] = [];

          for (const tc of toolCallsThisTurn) {
            const toolStart = Date.now();
            try {
              const result = await callTool(tc.name, tc.args);
              const resultStr =
                typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2);
              const llmResult = formatToolResultForLLM(
                result,
                tc.args?.presentation,
              );
              const toolReturnedError = isToolErrorResult(result);

              if (toolReturnedError) {
                toolCallsFailed += 1;
                toolFailureThisTurn = true;
              } else {
                toolCallsSucceeded += 1;
              }

              logToolEval({
                ts: new Date().toISOString(),
                event: "tool_eval",
                requestId,
                sessionId,
                provider: providerKey,
                model,
                toolName: tc.name,
                args: tc.args,
                durationMs: Date.now() - toolStart,
                success: !toolReturnedError,
                timedOut: false,
                errorMessage: toolReturnedError ? resultStr : null,
                resultPresent: true,
                resultSizeChars: resultStr.length,
              });

              send({
                type: "tool_result",
                id: tc.id,
                result: typeof result === "string" ? result : result,
              });
              toolResultsThisTurn.push(result);

              // Add tool result to conversation
              currentMessages.push({
                role: "tool",
                content: llmResult,
                toolResult: {
                  id: tc.id,
                  result: llmResult,
                },
              });
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              const timedOut = /timed out/i.test(errMsg);

              toolCallsFailed += 1;
              toolFailureThisTurn = true;
              if (timedOut) {
                toolCallsTimedOut += 1;
              }

              logToolEval({
                ts: new Date().toISOString(),
                event: "tool_eval",
                requestId,
                sessionId,
                provider: providerKey,
                model,
                toolName: tc.name,
                args: tc.args,
                durationMs: Date.now() - toolStart,
                success: false,
                timedOut,
                errorMessage: errMsg,
                resultPresent: false,
                resultSizeChars: 0,
              });

              send({
                type: "tool_result",
                id: tc.id,
                result: { error: errMsg },
              });
              toolResultsThisTurn.push({ error: errMsg });
              currentMessages.push({
                role: "tool",
                content: JSON.stringify({ error: errMsg }),
                toolResult: {
                  id: tc.id,
                  result: JSON.stringify({ error: errMsg }),
                },
              });
            }
          }

          if (toolCallsThisTurn.length >= 2) {
            logCompositePattern({
              toolCalls: toolCallsThisTurn.map((tc) => ({
                name: tc.name,
                args: tc.args,
              })),
              userPrompt: userMessage,
            });
          }

          if (toolFailureThisTurn) {
            break;
          }

          if (shouldFinalizeAfterToolResult({
            userMessage,
            availableTools: tools,
            toolCallsFromThisTurn: toolCallsThisTurn,
            toolResults: toolResultsThisTurn,
          })) {
            const finalTurn = await runProviderTurn({
              provider,
              messages: buildFinalSummaryMessages(currentMessages),
              tools: [],
              signal: abortController.signal,
              send,
              onTextDelta: () => {
                if (timeToFirstTokenMs === null) {
                  timeToFirstTokenMs = Date.now() - requestStart;
                }
              },
            });

            fullAssistantText += finalTurn.assistantText;
            finalStopReason = "final_summary";
            completed = true;
            if (finalTurn.usage) {
              lastPromptTokens = finalTurn.usage.promptTokens;
              lastCompletionTokens = finalTurn.usage.completionTokens;
            }
            if (finalTurn.hadError) {
              hadError = true;
              errorMessage = finalTurn.errorMessage;
            }
            break;
          }

          // Continue the loop if the provider signaled tool calls.
          // OpenAI uses "tool_calls", Anthropic uses "tool_use".
          if (
            turn.stopReason !== "tool_calls" &&
            turn.stopReason !== "tool_use" &&
            turn.stopReason !== "function_call"
          ) {
            break;
          }
        }

        // Signal completion with usage data if available
        send({
          type: "done",
          stopReason: "end_turn",
          ...(lastPromptTokens !== null
            ? { usage: { promptTokens: lastPromptTokens, completionTokens: lastCompletionTokens ?? 0 } }
            : {}),
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("[agent-loop] Error:", errMsg);
        hadError = true;
        errorMessage = errMsg;
        send({ type: "error", message: errMsg });
        send({ type: "done", stopReason: "error" });
        finalStopReason = "error";
      } finally {
        logChatEval({
          ts: new Date().toISOString(),
          event: "chat_eval",
          requestId,
          sessionId,
          provider: providerKey,
          model,
          promptCategory,
          userPrompt: body?.message || "",
          promptChars: body?.message.length || 0,
          historyMessageCount: body?.history?.length || 0,
          toolIntentExpected: tools.length > 0,
          toolCallsAttempted,
          toolCallsSucceeded,
          toolCallsFailed,
          toolCallsTimedOut,
          toolFailureOccurred: toolCallsFailed > 0 || toolCallsTimedOut > 0,
          toolResultPresent: toolCallsSucceeded > 0,
          substantiveAnswerReturned: fullAssistantText.trim().length > 0,
          timeToFirstTokenMs,
          timeToFirstToolCallMs,
          totalDurationMs: Date.now() - requestStart,
          inputTokens: null,
          outputTokens: null,
          estimatedCostUsd: null,
          stopReason: finalStopReason,
          completed,
          hadError,
          errorMessage,
          responseChars: fullAssistantText.length,
        });
        closeController();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}

/**
 * Build a system prompt that tells the LLM about the available tools
 * and gives it guidelines for using them effectively.
 */
function buildSystemPrompt(tools: Tool[], providerName: string): string {
  const toolList = tools
    .map(
      (t) =>
        `- **${t.name}**: ${t.description}`
    )
    .join("\n");

  return `You are a concise Moodle data analyst. You help users explore their courses, users, assignments, completion data, and recent activity.

You are running as: ${providerName}

Available tools:
${toolList}

CORE RULES (follow these strictly):
- NEVER invent, fabricate, or guess data. If you don't have specific item names or IDs in your tool context, do NOT list or enumerate individual items. The UI already renders the full result; your job is interpretation, not itemization.
- If the user asks for a list of things (courses, users, etc.) and your tool context only gives you summary metrics without individual names/IDs, respond with the metrics and refer the user to the rendered table in the UI.
- Respond in English unless the user asks for another language.
- Treat hierarchy words literally. "Sub categories", "children", "under", and "inside" mean child categories of a specific parent.
- When the user asks for sub categories:
  - If they provided a parent category name, call list_categories with parentname.
  - If they provided a parent category ID, call list_categories with parentid.
  - If the latest category tool result already resolved a parent, reuse that resolved parentid.
  - If no parent is named and no parent is resolved in the current conversation, ask one short clarification question instead of guessing.
- Never fuzzy-match category names silently. Use exact category names or IDs. If a tool reports ambiguity, ask the user which category they mean or use the exact ID/path from the tool result.

BEHAVIOR AFTER A TOOL CALL:
- One short takeaway sentence.
- One interpretive sentence or caution if useful.
- Do NOT suggest follow-up queries — the UI already shows them below your response.
- Do NOT restate displayed fields, recreate tables, or describe the raw payload.
- Do NOT say "included in the raw payload" or similar.
- When you see a [UI: ...] hint in a tool result, acknowledge that the user is already looking at that specific view. Do NOT direct the user to go to a view or page they are already seeing. Instead, talk about the data within that view.
- For detail tools like get_course, keep it to 1-2 sentences — the UI already shows the record.

TOOL USAGE:
- Prefer narrow calls over broad ones. Use limit/offset for list requests.
- For "first N" requests: pass limit=N, offset=0.
- Only request all results when the user explicitly asks for all.
- When listing users or assignments, always specify the courseid.
- If a tool returns an error, explain it and suggest alternatives. Do NOT auto-call fallback tools unless the user explicitly asked for that.

TONE:
- Sharp, concise, data-driven. Skip boilerplate, introductions, and filler.`;
}
