import { MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";

/**
 * list_assignments — List all assignments in a Moodle course.
 *
 * Uses mod_assign_get_assignments which returns assignment metadata
 * including due dates, submission/grading status, and grade settings.
 */
export const name = "list_assignments";

export const description =
  "List all assignments in a Moodle course. " +
  "Returns assignment ID, name, due date, allowed submission types, " +
  "grade scale, and whether submissions are open. " +
  "Does not return student submissions — use a separate tool for that.";

export const inputSchema = z.object({
  /** Course ID */
  courseid: z.number().int().positive().describe("Moodle course ID"),
});

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as { courseid: number };

    const available = hasCapability(caps, "mod_assign_get_assignments");
    if (!available) {
      return buildToolErrorResponse({
        error:
          "mod_assign_get_assignments is not available on this Moodle instance.",
        summary:
          "I could not list assignments because this Moodle token does not expose the assignments API.",
        meta: {
          tool: name,
          title: `Assignments — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        suggestedQueries: [
          `Get course details for [Course ID]`,
          `List users in course [Course ID]`,
        ],
      });
    }

    const data = await client.call<
      Array<{
        id: number;
        assignments: Array<{
          id: number;
          cmid: number;
          name: string;
          intro: string;
          duedate: number;
          allowsubmissionsfromdate: number;
          cutoffdate: number;
          nosubmissions: number;
          submissiondrafts: number;
          grade: number;
          gradetype: number;
          maxattempts: number;
        }>;
      }>
    >({
      wsfunction: "mod_assign_get_assignments",
      params: {
        "courseids[0]": parsed.courseid,
      },
      responseKey: "courses",
    });

    if (!data || data.length === 0) {
      return buildToolResponse({
        meta: {
          tool: name,
          title: `Assignments — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        data: {
          kind: "table",
          title: `Assignments — Course ${parsed.courseid}`,
          columns: [
            { key: "id", label: "Assignment ID" },
            { key: "name", label: "Assignment" },
            { key: "duedate", label: "Due Date" },
          ],
          rows: [],
        },
        context: {
          summary: `No assignments were returned for course ${parsed.courseid}.`,
          metrics: {
            total: 0,
          },
          suggestedQueries: [
            `Get course details for [Course ID]`,
            `Show recent activity in course [Course ID]`,
          ],
          fields: ["id", "name", "duedate"],
        },
      });
    }

    const assignments = data[0].assignments ?? [];

    const rows = assignments.map((a: {
        id: number;
        cmid: number;
        name: string;
        intro: string;
        duedate: number;
        allowsubmissionsfromdate: number;
        cutoffdate: number;
        nosubmissions: number;
        submissiondrafts: number;
        grade: number;
        gradetype: number;
        maxattempts: number;
      }) => ({
        id: a.id,
        cmid: a.cmid,
        name: a.name,
        intro: a.intro?.substring(0, 200) ?? null,
        duedate: a.duedate
          ? new Date(a.duedate * 1000).toISOString()
          : null,
        allowsubmissionsfrom: a.allowsubmissionsfromdate
          ? new Date(a.allowsubmissionsfromdate * 1000).toISOString()
          : null,
        cutoffdate: a.cutoffdate
          ? new Date(a.cutoffdate * 1000).toISOString()
          : null,
        maxgrade: a.grade || null,
        maxattempts: a.maxattempts ?? -1,
        submissionsopen: a.nosubmissions === 0,
        submissionsDraftMode: a.submissiondrafts === 1,
      }));

    const upcomingCount = rows.filter(
      (row) => typeof row.duedate === "string" && new Date(row.duedate) > new Date()
    ).length;

    return buildToolResponse({
      meta: {
        tool: name,
        title: `Assignments — Course ${parsed.courseid}`,
        entity: "course",
        entityId: parsed.courseid,
        resultCount: rows.length,
      },
      data: {
        kind: "table",
        title: `Assignments — Course ${parsed.courseid}`,
        columns: [
          { key: "id", label: "Assignment ID" },
          { key: "name", label: "Assignment" },
          { key: "duedate", label: "Due Date" },
          { key: "maxgrade", label: "Max Grade" },
          { key: "submissionsopen", label: "Open" },
        ],
        rows,
      },
      context: {
        summary:
          `Course ${parsed.courseid} has ${rows.length} assignments. ` +
          `${upcomingCount} still have future due dates.`,
        metrics: {
          total: rows.length,
          upcoming: upcomingCount,
          closed: rows.length - upcomingCount,
        },
        suggestedQueries: [
          `Show recent activity in course [Course ID]`,
          `Get course details for [Course ID]`,
          `List enrolled users in course [Course ID]`,
        ],
        fields: [
          "id",
          "cmid",
          "name",
          "duedate",
          "allowsubmissionsfrom",
          "cutoffdate",
          "maxgrade",
          "submissionsopen",
        ],
      },
    });
  };
}
