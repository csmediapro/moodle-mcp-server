/**
 * GET /api/status — lightweight connectivity check.
 * Returns live Moodle site info (cached probe from server startup).
 * No warming needed — the MCP server does that eagerly in main().
 */

import { NextResponse } from "next/server";
import { initMCPClient, callTool } from "@/lib/mcp-client";
import { ensureMCPReady, tokenFromHeaders } from "@/lib/mcp-init";
import { readServerDisplayConfig } from "@/lib/server-config";

export async function GET(request: Request) {
  try {
    await ensureMCPReady(tokenFromHeaders(request.headers));

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
