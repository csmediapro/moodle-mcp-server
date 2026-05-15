/**
 * Normalized event types — the contract between LLM adapters and the agent loop.
 *
 * Every adapter translates its provider's wire format into these events.
 * The agent loop never sees provider-specific shapes; it only processes
 * these normalized types. This is how we keep provider changes from
 * touching core agent logic.
 */

/** Normalized events emitted by every LLM provider adapter */
export type LLMEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; result: unknown }
  | { type: "error"; message: string }
  | { type: "done"; stopReason: string; usage?: { promptTokens: number; completionTokens: number } };

/** A message in the conversation — maps to both user and assistant turns */
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Tool calls from a previous assistant turn (for conversation continuity) */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: unknown;
  }>;
  /** A tool result from a previous interaction */
  toolResult?: {
    id: string;
    result: string;
  };
  /** Legacy support for OpenAI's tool_call_id format */
  toolCallId?: string;
}

/** An MCP tool definition, normalized for the adapter to translate */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Every LLM provider adapter implements this interface */
export interface LLMProvider {
  /** Human-readable name for display */
  name: string;
  /**
   * Generate a streaming completion.
   *
   * @param opts.messages — Conversation history (user/assistant/system)
   * @param opts.tools — Available MCP tools (translated into provider format by the adapter)
   * @param opts.signal — AbortSignal for cancellation
   * @returns AsyncIterable of normalized LLMEvents
   */
  generate(opts: {
    messages: Message[];
    tools: Tool[];
    signal?: AbortSignal;
  }): AsyncIterable<LLMEvent>;
}
