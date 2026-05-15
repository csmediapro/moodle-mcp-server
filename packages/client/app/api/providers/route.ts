import { NextResponse } from "next/server";
import { discoverProviders } from "@/lib/llm/discovery";

/**
 * GET /api/providers — returns the list of available LLM providers
 * so the UI can populate the provider/model selector.
 */
export async function GET() {
  try {
    const discovered = await discoverProviders();
    return NextResponse.json(discovered);
  } catch (error) {
    return NextResponse.json(
      {
        providers: [],
        activeProvider: "",
        activeModel: "",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
