import { MoodleAPIError, MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolErrorResponse, buildToolResponse } from "./response-types.js";

/**
 * get_recent_activity — Fetch recent activity in a Moodle course.
 *
 * Uses core_recent_get_recent_activities which returns a feed of
 * recent actions (new forum posts, assignment submissions, resource views, etc.)
 * scoped to a course.
 */
export const name = "get_recent_activity";

export const description =
  "Fetch recent activity in a Moodle course. " +
  "Returns a chronological feed of actions: new forum posts, " +
  "assignment submissions, resource views, and other course events. " +
  "Useful for getting a quick pulse on course activity without " +
  "calling individual APIs for each activity type.";

export const inputSchema = z.object({
  /** Course ID */
  courseid: z.number().int().positive().describe("Moodle course ID"),
  /** Optional: number of recent activities to return (default 20) */
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Number of recent activities to return (max 100)"),
});

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      courseid: number;
      limit: number;
    };

    if (!hasCapability(caps, "core_recent_get_recent_activities")) {
      return buildToolErrorResponse({
        error: {
          code: "moodle_recent_activity_unavailable",
          message: "core_recent_get_recent_activities is not available on this Moodle instance.",
          kind: "capability",
          canRetry: false,
          actionRequired: "Add core_recent_get_recent_activities to the external service or use a different activity endpoint.",
        },
        summary:
          "I could not fetch recent activity because this Moodle service does not expose the recent-activity endpoint to the current API token.",
        meta: {
          tool: name,
          title: `Recent Activity — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        suggestedQueries: [
          `Get course details for [Course ID]`,
          `List assignments in course [Course ID]`,
        ],
      });
    }

    type MoodleActivity = {
      modname: string;
      name: string;
      timeaccess?: number;
      timemodified?: number;
      userid?: number;
      userfullname?: string;
      url?: string;
      type?: string;
      isnew?: boolean;
    };

    // core_recent_get_recent_activities doesn't have a responseKey wrapper
    // It returns a direct array
    let activities;
    try {
      activities = await client.call<MoodleActivity[]>({
        wsfunction: "core_recent_get_recent_activities",
        params: {
          courseid: parsed.courseid,
          limit: parsed.limit,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isExternalFunctionIssue =
        error instanceof MoodleAPIError && /external_functions/i.test(message);

      return buildToolErrorResponse({
        error: {
          code: isExternalFunctionIssue
            ? "moodle_recent_activity_external_service_missing"
            : "moodle_recent_activity_failed",
          message,
          kind: isExternalFunctionIssue ? "capability" : "upstream",
          canRetry: false,
          actionRequired: isExternalFunctionIssue
            ? "Expose the recent-activity function in the Moodle external service used by this token, or switch to a supported activity endpoint."
            : "Review the Moodle API token permissions and retry after the upstream issue is resolved.",
        },
        summary: isExternalFunctionIssue
          ? "I could not fetch recent activity because the current Moodle external service does not have a working recent-activity function behind this API route."
          : "I could not fetch recent activity because Moodle rejected the recent-activity request.",
        meta: {
          tool: name,
          title: `Recent Activity — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        highlights: [
          isExternalFunctionIssue
            ? "The API route exists, but Moodle could not resolve the backing external function record."
            : "The recent-activity request reached Moodle but failed upstream.",
        ],
        warnings: [
          isExternalFunctionIssue
            ? "This usually points to an external-service exposure/configuration problem rather than a bad course ID."
            : "This error came from Moodle, not from the MCP transport layer.",
        ],
        suggestedQueries: [
          `Get course details for [Course ID]`,
          `List assignments in course [Course ID]`,
          `List users in course [Course ID]`,
        ],
      });
    }

    // The response may be wrapped in an array or come back as-is
    const items = Array.isArray(activities) ? activities : [];

    const rows = items.map((a) => ({
        modname: a.modname || "unknown",
        name: a.name || "Untitled",
        timestamp: a.timemodified || a.timeaccess
          ? new Date(
              ((a.timemodified || a.timeaccess) as number) * 1000
            ).toISOString()
          : null,
        user: a.userfullname || "Unknown",
        userid: a.userid ?? null,
        isnew: a.isnew ?? null,
      }));

    const uniqueUsers = new Set(rows.map((row) => row.userid).filter(Boolean)).size;

    return buildToolResponse({
      meta: {
        tool: name,
        title: `Recent Activity — Course ${parsed.courseid}`,
        entity: "course",
        entityId: parsed.courseid,
        resultCount: rows.length,
      },
      data: {
        kind: "table",
        title: `Recent Activity — Course ${parsed.courseid}`,
        columns: [
          { key: "timestamp", label: "Timestamp" },
          { key: "modname", label: "Module" },
          { key: "name", label: "Activity" },
          { key: "user", label: "User" },
          { key: "isnew", label: "New" },
        ],
        rows,
      },
      context: {
        summary:
          `Returned ${rows.length} recent activity items for course ${parsed.courseid} involving ${uniqueUsers} users.`,
        metrics: {
          total: rows.length,
          unique_users: uniqueUsers,
          limit: parsed.limit,
        },
        suggestedQueries: [
          `List assignments in course [Course ID]`,
          `List enrolled users in course [Course ID]`,
          `Build completion report for course [Course ID]`,
        ],
        fields: ["timestamp", "modname", "name", "user", "userid", "isnew"],
      },
    });
  };
}
