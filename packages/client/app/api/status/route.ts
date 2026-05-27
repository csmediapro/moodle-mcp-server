/**
 * GET /api/status — lightweight connectivity check.
 * Returns live Moodle site info (cached probe from server startup).
 * No warming needed — the MCP server does that eagerly in main().
 */

import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initMCPClient, callTool } from "@/lib/mcp-client";
import { readServerDisplayConfig } from "@/lib/server-config";

export async function GET() {
  try {
    const configPath = resolve(process.cwd(), "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcp: { serverCommand: string; serverArgs: string[]; serverCwd?: string };
    };
    await initMCPClient(config.mcp);

    const result = await callTool("get_site_info", {});
    const { serverName } = readServerDisplayConfig();

    return NextResponse.json({
      ok: true,
      serverName,
      siteInfo: result,
    });
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
