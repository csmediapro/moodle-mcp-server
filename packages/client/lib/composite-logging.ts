import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface CompositeToolCall {
  name: string;
  args: unknown;
}

interface CompositePatternEntry {
  patternId: string;
  toolSequence: string[];
  argShapes: string[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  samplePrompts: string[];
  status: "unaddressed" | "reviewed" | "implemented";
}

const compositeLogPath = resolve(process.cwd(), "logs/composite-patterns.json");

function extractArgShape(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value;
  }

  return Object.keys(value)
    .sort()
    .join(",");
}

function loadPatterns(): CompositePatternEntry[] {
  try {
    return JSON.parse(readFileSync(compositeLogPath, "utf-8")) as CompositePatternEntry[];
  } catch {
    return [];
  }
}

export function logCompositePattern(input: {
  toolCalls: CompositeToolCall[];
  userPrompt: string;
}): void {
  if (input.toolCalls.length < 2) {
    return;
  }

  try {
    mkdirSync(dirname(compositeLogPath), { recursive: true });

    const toolSequence = input.toolCalls.map((tool) => tool.name);
    const argShapes = input.toolCalls.map((tool) => extractArgShape(tool.args));
    const patternSeed = JSON.stringify({ toolSequence, argShapes });
    const patternId = createHash("sha1").update(patternSeed).digest("hex").slice(0, 12);

    const patterns = loadPatterns();
    const now = new Date().toISOString();
    const existing = patterns.find((entry) => entry.patternId === patternId);

    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      if (
        input.userPrompt.trim() &&
        !existing.samplePrompts.includes(input.userPrompt.trim())
      ) {
        existing.samplePrompts = [...existing.samplePrompts, input.userPrompt.trim()].slice(0, 5);
      }
    } else {
      patterns.push({
        patternId,
        toolSequence,
        argShapes,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        samplePrompts: input.userPrompt.trim() ? [input.userPrompt.trim()] : [],
        status: "unaddressed",
      });
    }

    patterns.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
    writeFileSync(compositeLogPath, JSON.stringify(patterns, null, 2) + "\n");
  } catch (error) {
    console.warn(
      `[composite-logging] Failed to write composite pattern log: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
