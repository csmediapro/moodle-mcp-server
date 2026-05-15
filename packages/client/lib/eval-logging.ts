import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ChatEvalLogEntry {
  ts: string;
  event: "chat_eval";
  requestId: string;
  sessionId: string;
  provider: string;
  model: string;
  promptCategory: string;
  userPrompt: string;
  promptChars: number;
  historyMessageCount: number;
  toolIntentExpected: boolean;
  toolCallsAttempted: number;
  toolCallsSucceeded: number;
  toolCallsFailed: number;
  toolCallsTimedOut: number;
  toolFailureOccurred: boolean;
  toolResultPresent: boolean;
  substantiveAnswerReturned: boolean;
  timeToFirstTokenMs: number | null;
  timeToFirstToolCallMs: number | null;
  totalDurationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  stopReason: string | null;
  completed: boolean;
  hadError: boolean;
  errorMessage: string | null;
  responseChars: number;
}

export interface ToolEvalLogEntry {
  ts: string;
  event: "tool_eval";
  requestId: string;
  sessionId: string;
  provider: string;
  model: string;
  toolName: string;
  args: unknown;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
  errorMessage: string | null;
  resultPresent: boolean;
  resultSizeChars: number;
}

const evalLogPath = resolve(process.cwd(), "logs/model-evals.jsonl");
let initialized = false;

export function logChatEval(entry: ChatEvalLogEntry): void {
  writeEvalEntry(entry);
}

export function logToolEval(entry: ToolEvalLogEntry): void {
  writeEvalEntry(entry);
}

function writeEvalEntry(entry: ChatEvalLogEntry | ToolEvalLogEntry): void {
  try {
    if (!initialized) {
      mkdirSync(dirname(evalLogPath), { recursive: true });
      initialized = true;
    }

    appendFileSync(evalLogPath, JSON.stringify(entry) + "\n");
  } catch (error) {
    console.warn(
      `[eval-logging] Failed to write eval log: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
