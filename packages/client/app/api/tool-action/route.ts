import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { callTool, initMCPClient, listTools } from "@/lib/mcp-client";

let mcpInitialized = false;

async function ensureMCPReady() {
  if (mcpInitialized) return;

  const configPath = resolve(process.cwd(), "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
    mcp: { serverCommand: string; serverArgs: string[]; serverCwd?: string };
  };

  await initMCPClient(config.mcp);
  mcpInitialized = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    if (!isRecord(body) || typeof body.tool !== "string" || !body.tool.trim()) {
      return NextResponse.json(
        { ok: false, error: "Missing tool name" },
        { status: 400 },
      );
    }

    const args = isRecord(body.args) ? body.args : {};

    await ensureMCPReady();

    const toolName = body.tool.trim();
    const toolExists = listTools().some((tool) => tool.name === toolName);
    if (!toolExists) {
      return NextResponse.json(
        { ok: false, error: `Unknown tool: ${toolName}` },
        { status: 404 },
      );
    }

    const result = await callTool(toolName, args);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
