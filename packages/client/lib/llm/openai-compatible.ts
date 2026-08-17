/**
 * OpenAI-compatible API adapter.
 *
 * Translates: internal Message[] + Tool[] → OpenAI chat completions request
 * Parses: OpenAI SSE event stream → normalized LLMEvents
 *
 * Works against: OpenAI, Ollama, LM Studio, llama.cpp server, vLLM,
 * and any other OpenAI-compatible endpoint.
 *
 * ⚠️ This adapter has the most edge cases. Streaming tool calls in the
 * OpenAI format arrive as token-by-token deltas across multiple SSE events.
 * You must accumulate them into valid JSON before invoking the tool.
 *
 * Key details about OpenAI's streaming format:
 * - Events carry: { object: "chat.completion.chunk", choices:[{delta:{...}}] }
 * - Text arrives as choices[0].delta.content (string chunks)
 * - Tool calls arrive as choices[0].delta.tool_calls[{index, function:{name,arguments}}]
 * - Arguments stream token-by-token — accumulate and parse at the end
 * - finish_reason on the last chunk signals "stop", "tool_calls", "length", etc.
 * - Ollama sends "done" as finish_reason; OpenAI sends "stop"
 *
 * Known quirks across providers:
 * - Ollama sometimes sends the full tool call in one chunk instead of streaming arguments
 * - Ollama may omit the role field on the delta
 * - Some local servers don't set finish_reason on the correct chunk
 * - vLLM may send empty content deltas interspersed with tool calls
 * - Assumes one data: line per SSE event (chat completion providers
 *   don't multi-line data fields).
 */

import { LLMEvent, LLMProvider, Message, Tool } from "./types";

interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig
): LLMProvider {
  return {
    name: `${config.displayName || "OpenAI Compat"} (${config.model})`,
    async *generate({
      messages,
      tools,
      signal,
    }): AsyncIterable<LLMEvent> {
      const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

      const body: Record<string, unknown> = {
        model: config.model,
        messages: translateMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length > 0
          ? {
              tools: translateTools(tools),
              tool_choice: "auto",
            }
          : {}),
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `OpenAI-compatible API error ${res.status} (${url}): ${errBody.slice(0, 500)}`
        );
      }

      let stopReason = "";
      // Track accumulating tool calls by index
      const toolCallsAccumulator = new Map<
        number,
        { id: string; name: string; argChunks: string[] }
      >();
      // Capture usage from the final streaming chunk
      let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const textDecoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        // Split on CRLF or LF — OpenAI sends CRLF, Ollama sends LF
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const json = line.replace(/^data:\s*/, "").trim();

          if (json === "[DONE]") continue;
          if (!json) continue;

          try {
            const chunk = JSON.parse(json);

            // llama.cpp + OpenAI send usage on the final stream chunk
            if (chunk.usage) {
              capturedUsage = {
                promptTokens: chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? 0,
              };
            }

            const choices = chunk.choices as
              | Array<{
                  delta?: Record<string, unknown>;
                  finish_reason?: string;
                }>
              | undefined;

            if (!choices || choices.length === 0) continue;

            const delta = choices[0].delta;
            const finishReason = choices[0].finish_reason;

            // Process tool calls in the delta
            if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls as Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>) {
                const idx = tc.index;
                let entry = toolCallsAccumulator.get(idx);
                if (!entry) {
                  entry = {
                    id: tc.id || `call_${idx}`,
                    name: tc.function?.name || "unknown",
                    argChunks: [],
                  };
                  toolCallsAccumulator.set(idx, entry);
                }
                // Update id/name if they come later (some providers send them after init)
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) {
                  entry.argChunks.push(tc.function.arguments);
                }
              }
            }

            // Process text content
            if (delta?.content) {
              yield {
                type: "text_delta",
                text: delta.content as string,
              };
            }

            // Handle finish: flush accumulated tool calls ONLY on tool_calls
            if (finishReason === "tool_calls") {
              // Emit accumulated tool calls
              for (const [, entry] of toolCallsAccumulator) {
                const rawArgs = entry.argChunks.join("");
                let args: unknown;
                try {
                  args = JSON.parse(rawArgs);
                } catch {
                  args = rawArgs || {};
                }
                yield {
                  type: "tool_call",
                  id: entry.id,
                  name: entry.name,
                  args,
                };
              }
              toolCallsAccumulator.clear();
            }

            if (finishReason) {
              stopReason = finishReason;
            }
          } catch {
            // Skip parse errors — some servers send non-JSON SSE lines
          }
        }
      }

      // Process any leftover buffer
      if (buffer) {
        const json = buffer.replace(/^data:\s*/, "").trim();
        if (json && json !== "[DONE]") {
          try {
            const chunk = JSON.parse(json);
            const choices = chunk.choices as
              | Array<{ delta?: { content?: string }; finish_reason?: string }>
              | undefined;
            if (choices?.[0]?.finish_reason) {
              stopReason = choices[0].finish_reason;
            }
          } catch { /* ignore */ }
        }
      }

      yield {
        type: "done",
        stopReason: stopReason || "stop",
        ...(capturedUsage ? { usage: capturedUsage } : {}),
      };
    },
  };
}

/** Translate internal Message[] to OpenAI message format */
function translateMessages(
  messages: Message[]
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  let systemPrompt = "";
  const msgs: Message[] = [...messages];

  // Extract system messages to the top-level system field
  const nonSystem = msgs.filter((m) => {
    if (m.role === "system") {
      systemPrompt += (systemPrompt ? "\n\n" : "") + m.content;
      return false;
    }
    return true;
  });

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of nonSystem) {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      result.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments:
              typeof tc.args === "string"
                ? tc.args
                : JSON.stringify(tc.args),
          },
        })),
      });
    } else if (msg.toolResult) {
      result.push({
        role: "tool",
        tool_call_id: msg.toolResult.id,
        content:
          typeof msg.toolResult.result === "string"
            ? msg.toolResult.result
            : JSON.stringify(msg.toolResult.result),
      });
    } else if (msg.toolCallId) {
      // Backward compat: message with toolCallId is a tool response
      result.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}

/** Translate internal Tool[] to OpenAI tool format */
function translateTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
