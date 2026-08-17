/**
 * Anthropic Messages API adapter.
 *
 * Translates: internal Message[] + Tool[] → Anthropic request shape
 * Parses: Anthropic SSE event stream → normalized LLMEvents
 *
 * Key details about Anthropic's streaming format:
 * - Events: message_start, content_block_start, content_block_delta,
 *   content_block_stop, message_delta, message_stop, ping
 * - Tool use: starts with content_block_start (block type: tool_use),
 *   followed by content_block_delta for argument deltas (JSON string chunks),
 *   then content_block_stop. The full JSON is assembled from deltas.
 * - Content blocks can interleave text and tool_use.
 * - stop_reason is on message_delta, NOT message_stop.
 *   message_stop has no stop_reason field.
 * - SSE uses both event: and data: lines. The type field is duplicated
 *   in the JSON payload, so we ignore event: lines.
 * - Assumes one data: line per SSE event (chat completion providers
 *   don't multi-line data fields).
 */

import { LLMEvent, LLMProvider, Message, Tool } from "./types";

interface AnthropicConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
}

export function createAnthropicProvider(config: AnthropicConfig): LLMProvider {
  return {
    name: `${config.displayName || "Anthropic"} (${config.model})`,
    async *generate({ messages, tools, signal }): AsyncIterable<LLMEvent> {
      const url = `${config.baseUrl.replace(/\/$/, "")}/v1/messages`;

      // Extract system messages to the top-level system field
      const { systemPrompt, conversationMessages } =
        extractSystem(messages);

      const body = {
        model: config.model,
        max_tokens: 4096,
        stream: true,
        messages: translateMessages(conversationMessages),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(tools.length > 0 ? { tools: translateTools(tools) } : {}),
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `Anthropic API error ${res.status}: ${errBody.slice(0, 500)}`
        );
      }

      let stopReasonFromDelta = "";
      // Track in-progress tool use blocks: index → { id, name, argChunks }
      const toolUseInProgress = new Map<
        number,
        { id: string; name: string; argChunks: string[] }
      >();
      // Capture usage from message_start and message_delta
      let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      // Read SSE event stream
      const textDecoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });

        // Process complete SSE events from the buffer
        // Split on CRLF or LF — Anthropic uses LF, but be robust against CRLF
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || ""; // Keep incomplete last line

        for (const line of lines) {
          if (!line.trimStart().startsWith("data: ")) continue;
          const json = line.slice(line.indexOf("data:") + 5).trim();

          // Anthropic sends [DONE] or empty data lines
          if (json === "" || json === "[DONE]") continue;

          try {
            const event = JSON.parse(json) as Record<string, unknown>;

            // Capture Anthropic usage from message_start and message_delta
            // before delegating to processSSEEvent
            if (event.type === "message_start") {
              const msg = event.message as Record<string, unknown> | undefined;
              if (msg?.usage) {
                const u = msg.usage as { input_tokens?: number };
                capturedUsage = {
                  promptTokens: u.input_tokens ?? 0,
                  completionTokens: 0,
                };
              }
            } else if (event.type === "message_delta" && capturedUsage) {
              if (event.usage) {
                const u = event.usage as { output_tokens?: number };
                capturedUsage.completionTokens = u.output_tokens ?? 0;
              }
            }

            const sseResult = processSSEEvent(
              event,
              toolUseInProgress
            );
            for (const ev of sseResult.events) {
              yield ev;
            }
            if (sseResult.stopReason) {
              stopReasonFromDelta = sseResult.stopReason;
            }
          } catch {
            // Skip parse errors on malformed lines
          }
        }
      }

      // Clean up any remaining data in the buffer
      if (buffer.trimStart().startsWith("data: ")) {
        const json = buffer.slice(buffer.indexOf("data:") + 5).trim();
        if (json && json !== "[DONE]") {
          try {
            const event = JSON.parse(json);
            const sseResult = processSSEEvent(event, toolUseInProgress);
            for (const ev of sseResult.events) {
              yield ev;
            }
          } catch { /* ignore */ }
        }
      }

      // Use stop_reason from message_delta if we captured one;
      // fall back to "end_turn" (message_stop has no stop_reason field).
      yield {
        type: "done",
        stopReason: stopReasonFromDelta || "end_turn",
        ...(capturedUsage ? { usage: capturedUsage } : {}),
      };
    },
  };
}

/**
 * Process a single SSE event and return normalized events + any stop reason.
 *
 * Returns { events, stopReason } — the caller aggregates stopReason from
 * message_delta events and yields yielded events to the agent loop.
 */
function processSSEEvent(
  event: Record<string, unknown>,
  toolUseInProgress: Map<
    number,
    { id: string; name: string; argChunks: string[] }
  >
): { events: LLMEvent[]; stopReason?: string } {
  const events: LLMEvent[] = [];
  let stopReason: string | undefined;

  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        const idx = event.index as number;
        // Anthropic may not send the id in content_block_start for older models
        // so we set up the entry here and fill it in from the first delta
        toolUseInProgress.set(idx, {
          id: (block.id as string) || `tool_${idx}`,
          name: (block.name as string) || "unknown",
          argChunks: [],
        });
      }
      // text blocks: no-op — content arrives via deltas
      break;
    }

    case "content_block_delta": {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) break;

      if (delta.type === "text_delta") {
        events.push({
          type: "text_delta",
          text: (delta.text as string) || "",
        });
      } else if (delta.type === "input_json_delta") {
        const idx = event.index as number;
        const inProgress = toolUseInProgress.get(idx);
        if (inProgress) {
          inProgress.argChunks.push((delta.partial_json as string) || "");
        }
      }
      break;
    }

    case "content_block_stop": {
      const idx = event.index as number;
      const inProgress = toolUseInProgress.get(idx);
      if (inProgress) {
        const rawArgs = inProgress.argChunks.join("");
        let args: unknown;
        if (rawArgs.trim() === "") {
          args = {};
        } else {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = rawArgs; // Best effort — pass raw string
          }
        }
        events.push({
          type: "tool_call",
          id: inProgress.id,
          name: inProgress.name,
          args,
        });
        toolUseInProgress.delete(idx);
      }
      break;
    }

    case "message_delta": {
      // stop_reason lives here in Anthropic's format, NOT on message_stop
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason) {
        stopReason = delta.stop_reason as string;
      }
      break;
    }

    case "message_stop":
      // No stop_reason here — we already captured it from message_delta.
      // If we never saw message_delta (shouldn't happen), fall back.
      break;

    case "error": {
      const err = event.error as { message?: string } | undefined;
      events.push({
        type: "error",
        message: err?.message || "Unknown Anthropic error",
      });
      break;
    }
  }

  return { events, stopReason };
}

/** Extract system messages from the message array for top-level system field */
function extractSystem(messages: Message[]): {
  systemPrompt: string;
  conversationMessages: Message[];
} {
  let systemPrompt = "";
  const conversationMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else {
      conversationMessages.push(msg);
    }
  }

  return { systemPrompt, conversationMessages };
}

/** Translate internal Message[] to Anthropic's message format */
function translateMessages(
  messages: Message[]
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {

    // Build content blocks for the message
    const contentBlocks: Array<Record<string, unknown>> = [];

    if (msg.content) {
      contentBlocks.push({ type: "text", text: msg.content });
    }

    // Tool calls from a previous assistant turn
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: normalizeAnthropicToolInput(tc.args),
        });
      }
    }

    // Tool results become user messages with tool_result blocks
    if (msg.toolResult) {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolResult.id,
            content:
              typeof msg.toolResult.result === "string"
                ? msg.toolResult.result
                : JSON.stringify(msg.toolResult.result),
          },
        ],
      });
      continue;
    }

    // If this is a tool response from OpenAI history, convert
    if (msg.toolCallId) {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content:
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: contentBlocks,
      });
    } else {
      result.push({ role: "user", content: msg.content });
    }
  }

  return result;
}

/** Translate internal Tool[] to Anthropic's tool format */
function translateTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function normalizeAnthropicToolInput(args: unknown): Record<string, unknown> {
  if (isPlainObject(args)) {
    return args;
  }

  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse failure; fall through to wrapper object
    }

    return { input: args };
  }

  return { input: args };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
