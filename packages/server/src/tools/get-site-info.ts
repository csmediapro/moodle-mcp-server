import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolResponse } from "./response-types.js";
import { getCourses } from "./cache.js";

/**
 * get_site_info — Live connectivity check + cached site metadata.
 *
 * Returns the Moodle site info already probed at startup. Also reads
 * the course cache (warmed during main()) to report total course count
 * without making any Moodle API calls.
 */
export const name = "get_site_info";

export const description =
  "Returns information about the connected LMS instance: " +
  "site name, version, release, authenticated user, available API functions, " +
  "and total course count (from the pre-warmed cache). " +
  "No parameters required — always returns cached data.";

export const inputSchema = z.object({});

export function createHandler(
  client: MoodleClient,
  caps: MoodleCapabilities,
) {
  return async () => {
    // Read course count from the pre-warmed cache — no Moodle API call,
    // just hitting the in-memory array populated during server startup.
    let courseCount: number | null = null;
    try {
      const courses = await getCourses(client);
      courseCount = courses.length;
    } catch {
      courseCount = null;
    }

    const record = {
      siteName: caps.siteName ?? null,
      version: caps.version ?? null,
      release: caps.release ?? null,
      username: caps.username ?? null,
      userId: caps.userId ?? null,
      isSiteAdmin: caps.isSiteAdmin ?? false,
      functionCount: caps.functions.size,
      ...(courseCount !== null ? { courseCount } : {}),
    };

    const summaryParts: string[] = [];
    if (caps.siteName) {
      summaryParts.push(
        `Connected to ${caps.siteName} (${caps.release ?? "unknown version"})`,
      );
    }
    summaryParts.push(`authenticated as ${caps.username ?? "?"}`);
    summaryParts.push(`${caps.functions.size} API functions available`);
    if (courseCount !== null) {
      summaryParts.push(`${courseCount} courses pre-cached`);
    }

    return buildToolResponse({
      meta: {
        tool: name,
        title: "LMS Site Info",
        entity: "lms_site",
        resultCount: 1,
      },
      data: {
        kind: "record",
        title: "LMS Site Info",
        record,
      },
      context: {
        summary: caps.siteName
          ? summaryParts.join(" — ") + "."
          : "Connected to LMS — site info not fully resolved.",
        metrics: {
          functionCount: caps.functions.size,
          isSiteAdmin: caps.isSiteAdmin ?? false,
          ...(courseCount !== null ? { courseCount } : {}),
        },
        suggestedQueries: [
          "List the first [N] courses",
          "Show recent activity in course [Course ID]",
        ],
        fields: Object.keys(record),
      },
    });
  };
}
