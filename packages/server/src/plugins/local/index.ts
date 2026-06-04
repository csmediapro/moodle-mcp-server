import { z } from "zod";
import type { MCPServerPlugin } from "../contracts.js";

/**
 * get_user_activity — Compound tool that chains:
 *   1. core_course_get_recent_courses(userid) → list of courses
 *   2. core_course_get_updates_since(courseid, since) → per-course activity
 *
 * Produces a unified per-user activity feed across all their recent courses.
 */

const inputSchema = z.object({
  userid: z
    .number()
    .int()
    .positive()
    .describe("Moodle user ID to query recent activity for"),
  since: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Unix timestamp — only include activity after this time (default: 7 days ago)"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Max courses to check (default 10, max 50)"),
});

const DAY_MS = 86_400_000;

export const plugin: MCPServerPlugin = {
  manifest: {
    id: "user-activity",
    name: "User Activity Feed",
    version: "0.1.0",
    apiVersion: "1",
    description:
      "Compound tool that chains Moodle's get_recent_courses + get_updates_since to build a per-user activity feed across all recently accessed courses.",
    requiresLicense: true,
    requiredCapabilities: [
      "core_course_get_recent_courses",
      "core_course_get_updates_since",
    ],
    tools: ["get_user_activity"],
  },

  tools: [
    {
      name: "get_user_activity",
      description:
        "Fetch recent activity for a specific user across all their recently " +
        "accessed courses. Chains core_course_get_recent_courses → " +
        "core_course_get_updates_since for each course to produce a unified " +
        "activity feed with timestamps, module types, and course context. " +
        "Useful for answering questions like 'what has this user been doing lately?' " +
        "or auditing student engagement.",
      inputSchema,

      createHandler(ctx) {
        return async (args: unknown) => {
          const parsed = inputSchema.parse(args) as {
            userid: number;
            since?: number;
            limit: number;
          };

          const since = parsed.since ?? Math.floor(Date.now() / 1000) - 7 * 86_400;
          const { moodleClient, log } = ctx;

          // Step 1: Get recent courses for the target user
          let recentCourses: Array<{ id: number; fullname: string; shortname: string }>;
          try {
            recentCourses = await moodleClient.call<Array<{ id: number; fullname: string; shortname: string }>>({
              wsfunction: "core_course_get_recent_courses",
              params: {
                userid: parsed.userid,
                limit: parsed.limit,
                offset: 0,
              },
            });
          } catch (e) {
            log("warn", `get_user_activity: failed to fetch recent courses for user ${parsed.userid}: ${e instanceof Error ? e.message : String(e)}`);
            return {
              context: {
                summary: `Could not retrieve recent courses for user ${parsed.userid}.`,
                warnings: ["The Moodle API rejected the recent-courses request for this user."],
              },
              resolution: { kind: "error", message: "Failed to fetch recent courses." },
            };
          }

          if (!Array.isArray(recentCourses) || recentCourses.length === 0) {
            return {
              context: {
                summary: `No recent courses found for user ${parsed.userid}.`,
                metrics: { totalCourses: 0, totalUpdates: 0 },
              },
              data: {
                kind: "empty",
                message: "No recent courses found for this user.",
              },
            };
          }

          // Step 2: Fan out to get_updates_since for each course
          const courseActivity: Array<{
            courseid: number;
            courseName: string;
            updateCount: number;
            updates: Array<{
              name: string;
              modname: string;
              timeupdated: number;
              url?: string;
              contextname?: string;
              itemtype?: string;
            }>;
          }> = [];

          for (const course of recentCourses.slice(0, parsed.limit)) {
            try {
              const updates = await moodleClient.call<{
                instances: Array<{
                  name: string;
                  modname?: string;
                  timeupdated?: number;
                  url?: string;
                  contextname?: string;
                  itemtype?: string;
                }>;
              }>({
                wsfunction: "core_course_get_updates_since",
                params: {
                  courseid: course.id,
                  since,
                },
              });

              const instances = updates?.instances ?? [];
              if (instances.length > 0) {
                courseActivity.push({
                  courseid: course.id,
                  courseName: course.fullname,
                  updateCount: instances.length,
                  updates: instances.map((u) => ({
                    name: u.name ?? "Untitled",
                    modname: u.modname ?? "unknown",
                    timeupdated: u.timeupdated ?? 0,
                    url: u.url,
                    contextname: u.contextname,
                    itemtype: u.itemtype,
                  })),
                });
              }
            } catch (e) {
              log("warn", `get_user_activity: failed to fetch updates for course ${course.id}: ${e instanceof Error ? e.message : String(e)}`);
              // Continue to next course — don't fail the whole compound call
            }
          }

          const totalUpdates = courseActivity.reduce((sum, c) => sum + c.updateCount, 0);

          // Build flat activity table rows
          const rows = courseActivity.flatMap((c) =>
            c.updates.map((u) => ({
              courseName: c.courseName,
              courseId: c.courseid,
              activity: u.name,
              module: u.modname,
              timestamp: u.timeupdated
                ? new Date(u.timeupdated * 1000).toISOString()
                : null,
            }))
          );

          return {
            meta: {
              tool: "get_user_activity",
              title: `Recent Activity — User ${parsed.userid}`,
              entity: "user",
              entityId: parsed.userid,
              resultCount: totalUpdates,
            },
            data: {
              kind: rows.length > 0 ? "table" : "empty",
              title: `Recent Activity — User ${parsed.userid}`,
              columns: [
                { key: "timestamp", label: "Timestamp" },
                { key: "courseName", label: "Course" },
                { key: "module", label: "Module" },
                { key: "activity", label: "Activity" },
              ],
              rows,
            },
            context: {
              summary:
                totalUpdates > 0
                  ? `Found ${totalUpdates} updates across ${courseActivity.length} recently accessed courses for user ${parsed.userid} since ${new Date(since * 1000).toISOString()}.`
                  : `User ${parsed.userid} has accessed ${recentCourses.length} course${recentCourses.length !== 1 ? "s" : ""} recently but no updates were found since ${new Date(since * 1000).toISOString()}.`,
              metrics: {
                totalCoursesChecked: courseActivity.length,
                totalUpdates,
                activeCourses: courseActivity.filter((c) => c.updateCount > 0).length,
                sinceTimestamp: since,
              },
              suggestedQueries: [
                `Get details for user ${parsed.userid}`,
                `Get course details for [Course ID]`,
                `List enrolled users in course [Course ID]`,
              ],
              fields: ["courseName", "courseId", "activity", "module", "timestamp"],
              entities: recentCourses.slice(0, parsed.limit).map((c) => ({
                id: String(c.id),
                type: "course",
                label: c.fullname,
                data: { id: c.id, shortname: c.shortname },
              })),
              primaryEntity: {
                id: String(parsed.userid),
                type: "user",
                label: `User ${parsed.userid}`,
              },
            } as any,
          };
        };
      },
    },
  ],
};
