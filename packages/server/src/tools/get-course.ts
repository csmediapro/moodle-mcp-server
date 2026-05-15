import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";
import { getCategories } from "./cache.js";

/**
 * get_course — Fetch full details for a single Moodle course.
 */
export const name = "get_course";

export const description =
  "Fetch complete details for a single Moodle course by ID. " +
  "Returns full name, short name, summary, category, format, start/end dates, " +
  "enrollment methods, and completion tracking settings.";

export const inputSchema = z.object({
  /** Course ID to fetch */
  courseid: z.number().int().positive().describe("Moodle course ID"),
});

export function createHandler(client: MoodleClient, _caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as { courseid: number };

    const courses = await client.call<
      Array<{
        id: number;
        fullname: string;
        shortname: string;
        summary: string;
        summaryformat: number;
        categoryid?: number;
        format?: string;
        startdate?: number;
        enddate?: number;
        numsections?: number;
        visible: number;
        enablecompletion?: number;
        completionnotify?: number;
      }>
    >({
      wsfunction: "core_course_get_courses_by_field",
      params: {
        field: "id",
        value: parsed.courseid,
      },
      responseKey: "courses",
    });

    if (!courses || courses.length === 0) {
      return buildToolErrorResponse({
        error: `Course ${parsed.courseid} not found or not accessible`,
        summary: `Course ${parsed.courseid} was not found or is not visible to the API token.`,
        meta: {
          tool: name,
          title: `Course Details — ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        suggestedQueries: [
          "List the first [N] courses",
          "Get details for course [Course ID]",
        ],
      });
    }

    const c = courses[0];
    const record = {
      id: c.id,
      fullname: c.fullname,
      shortname: c.shortname,
      summary: c.summary,
      categoryid: c.categoryid ?? null,
      format: c.format ?? "unknown",
      startdate: c.startdate ? new Date(c.startdate * 1000).toISOString() : null,
      enddate: c.enddate ? new Date(c.enddate * 1000).toISOString() : null,
      numsections: c.numsections ?? null,
      visible: c.visible === 1,
      enablecompletion: c.enablecompletion === 1,
    };

    return buildToolResponse({
      meta: {
        tool: name,
        title: `Course Details — ${c.fullname}`,
        entity: "course",
        entityId: c.id,
        resultCount: 1,
      },
      data: {
        kind: "record",
        title: `Course Details — ${c.fullname}`,
        record,
      },
      context: {
        summary:
          c.enablecompletion === 1
            ? "This course is a good candidate for enrollment and completion analysis because completion tracking is enabled."
            : "This course is best treated as a content and enrollment check, since completion tracking is not enabled.",
        metrics: {
          id: c.id,
          categoryid: c.categoryid ?? null,
          numsections: c.numsections ?? null,
          visible: c.visible === 1,
          enablecompletion: c.enablecompletion === 1,
        },
        suggestedQueries: [
          `List users in course ${c.id}`,
          `List assignments in course ${c.id}`,
          `Build the completion report for course ${c.id}`,
        ],
        fields: Object.keys(record),
      },
    });
  };
}
