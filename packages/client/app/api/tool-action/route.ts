import { NextRequest, NextResponse } from "next/server";
import { callTool, listTools } from "@/lib/mcp-client";
import { ensureMCPReady, tokenFromHeaders } from "@/lib/mcp-init";

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

    await ensureMCPReady(tokenFromHeaders(request.headers));

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
