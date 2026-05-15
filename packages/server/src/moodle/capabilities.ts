import { MoodleClient } from "./client.js";
import { logger } from "../logging/index.js";

/**
 * Set of Web Services function names discovered on the Moodle instance.
 * Used at runtime by tools to check whether a required API is available,
 * rather than hardcoding version strings or build-time assumptions.
 */
export interface MoodleCapabilities {
  /** All available wsfunction names */
  functions: Set<string>;
  /** Core version string (e.g. "2024042200") */
  version?: string;
  /** Release tag (e.g. "4.1.5 (Build: 20231204)") */
  release?: string;
  /** Moodle site name */
  siteName?: string;
  /** Authenticated username */
  username?: string;
  /** Authenticated user id */
  userId?: number;
  /** Whether the token belongs to a site administrator */
  isSiteAdmin?: boolean;
  /** When the capability probe last completed */
  probedAt: Date;
}

export interface ProbeOptions {
  allowDegraded?: boolean;
}

/**
 * Probe the Moodle instance for available Web Services functions.
 * Called once at startup — results are shared across all tool handlers.
 */
export async function probeCapabilities(
  client: MoodleClient,
  options: ProbeOptions = {}
): Promise<MoodleCapabilities> {
  try {
    // Fetch site info — this endpoint lists all available ws functions
    const body = await client.call<{
      functions?: Array<{ name: string; version: string }>;
      sitename?: string;
      username?: string;
      userid?: number;
      userissiteadmin?: boolean;
      version?: string;
      release?: string;
    }>({
      wsfunction: "core_webservice_get_site_info",
    });

    const functionNames = new Set((body.functions ?? []).map((f) => f.name));

    if (functionNames.size === 0) {
      throw new Error(
        "Moodle returned zero Web Services functions. The token likely has no functions assigned to its external service."
      );
    }

    const caps: MoodleCapabilities = {
      functions: functionNames,
      version: body.version,
      release: body.release,
      siteName: body.sitename,
      username: body.username,
      userId: body.userid,
      isSiteAdmin: body.userissiteadmin,
      probedAt: new Date(),
    };

    logger.info(
      `Connected to ${caps.siteName ?? "Moodle"} (${caps.release ?? caps.version ?? "unknown version"}) as ${caps.username ?? "?"} — ${functionNames.size} functions available`,
      {
        event: "capabilities_probed",
        release: caps.release,
        version: caps.version,
        siteName: caps.siteName,
        username: caps.username,
        userId: caps.userId,
        functionCount: functionNames.size,
        isSiteAdmin: caps.isSiteAdmin,
      }
    );

    if (caps.isSiteAdmin) {
      logger.warn(
        "Token belongs to a site administrator. Consider scoping to a dedicated service account for production.",
        { event: "site_admin_token_detected" }
      );
    }

    return caps;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (options.allowDegraded) {
      logger.warn(
        "Starting in degraded mode — tools will report unavailable",
        { event: "capabilities_probe_failed", error: msg }
      );
      return { functions: new Set(), probedAt: new Date() };
    }

    throw new Error(
      `Failed to probe Moodle capabilities: ${msg}\n` +
      `Check: (1) Moodle URL is correct, (2) token is valid, ` +
      `(3) Web Services are enabled, (4) the token's service includes core_webservice_get_site_info.`
    );
  }
}

/**
 * Check whether a given wsfunction is available on the connected instance.
 */
export function hasCapability(
  caps: MoodleCapabilities,
  functionName: string
): boolean {
  return caps.functions.has(functionName);
}

/**
 * Return the first available function name from a list of acceptable alternatives.
 * Use this when multiple Moodle WS functions can satisfy a tool requirement.
 *
 * NOTE: Currently capability == Moodle Web Services function name.
 * If we add non-WS data sources later, this should become a semantic
 * capability registry with WS being one resolver.
 */
export function resolveCapability(
  caps: MoodleCapabilities,
  candidates: string[]
): string | null {
  return candidates.find((fn) => caps.functions.has(fn)) ?? null;
}
