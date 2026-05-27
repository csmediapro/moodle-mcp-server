import { MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";
import { getCategories, getCourses } from "./cache.js";

export const name = "list_user_courses";

export const description =
  "List courses for a specific Moodle user ID. " +
  "Requires an exact userid. Use get_user for exact email or username lookups first. " +
  "Use search_users when a person is identified by name and multiple matches are possible. " +
  "If multiple people match, ask the operator to choose the correct userid before calling this tool.";

export const inputSchema = z.object({
  userid: z.number().int().positive().describe("Exact Moodle user ID"),
  limit: z.number().int().min(1).max(200).optional().default(25).describe("Maximum courses to return"),
  offset: z.number().int().min(0).optional().default(0).describe("Pagination offset"),
});

type MoodleUserCourse = {
  id: number;
  fullname: string;
  shortname: string;
  category?: number;
  visible?: number;
  startdate?: number;
  enddate?: number;
  progress?: number;
  completed?: boolean;
};

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      userid: number;
      limit: number;
      offset: number;
    };

    if (!hasCapability(caps, "core_enrol_get_users_courses")) {
      return buildToolErrorResponse({
        error: {
          code: "user_courses_capability_missing",
          message: "core_enrol_get_users_courses is not available on this Moodle instance.",
          kind: "capability",
          canRetry: false,
          actionRequired: "Use a Moodle token/service that exposes core_enrol_get_users_courses.",
        },
        summary: "I could not list courses for that user because this Moodle token does not expose the user-course enrollment API.",
        meta: {
          tool: name,
          title: `User Courses — ${parsed.userid}`,
          entity: "user",
          entityId: parsed.userid,
          resultCount: 0,
        },
        suggestedQueries: [
          "Get user by email [Exact Email]",
          "Search users by lastname [Last Name]",
        ],
      });
    }

    const [userCourses, categories, allCourses] = await Promise.all([
      client.call<MoodleUserCourse[]>({
        wsfunction: "core_enrol_get_users_courses",
        params: { userid: parsed.userid },
      }),
      getCategories(client),
      getCourses(client),
    ]);

    const categoryNameMap = new Map(categories.map((cat) => [cat.id, cat.name]));
    const categoryPathMap = new Map(categories.map((cat) => [cat.id, cat.path]));
    const completionMap = new Map(allCourses.map((course) => [course.id, course.enablecompletion === 1]));

    const total = userCourses.length;
    const paged = userCourses.slice(parsed.offset, parsed.offset + parsed.limit);

    const rows = paged.map((course) => ({
      id: course.id,
      fullname: course.fullname,
      shortname: course.shortname,
      categoryid: course.category ?? null,
      categoryname: course.category != null ? (categoryNameMap.get(course.category) ?? null) : null,
      categorypath: course.category != null ? (categoryPathMap.get(course.category) ?? null) : null,
      visible: course.visible === 1,
      completionenabled: completionMap.get(course.id) ?? null,
      progresspct: typeof course.progress === "number" ? course.progress : null,
      completed: typeof course.completed === "boolean" ? course.completed : null,
      startdate: course.startdate ? new Date(course.startdate * 1000).toISOString() : null,
      enddate: course.enddate ? new Date(course.enddate * 1000).toISOString() : null,
    }));

    return buildToolResponse({
      meta: {
        tool: name,
        title: `User Courses — ${parsed.userid}`,
        entity: "user",
        entityId: parsed.userid,
        resultCount: rows.length,
      },
      data: {
        kind: "table",
        title: `User Courses — ${parsed.userid}`,
        columns: [
          { key: "id", label: "Course ID" },
          { key: "fullname", label: "Course Name" },
          { key: "shortname", label: "Short Name" },
          { key: "categoryname", label: "Category" },
          { key: "visible", label: "Visible" },
          { key: "completionenabled", label: "Completion" },
          { key: "progresspct", label: "Progress" },
        ],
        rows,
        pagination: {
          offset: parsed.offset,
          limit: parsed.limit,
          total,
          hasMore: parsed.offset + parsed.limit < total,
        },
      },
      context: {
        summary:
          total === 0
            ? `User ${parsed.userid} is not enrolled in any visible courses.`
            : `Returned ${rows.length} of ${total} courses for user ${parsed.userid}.`,
        metrics: {
          userid: parsed.userid,
          returned: rows.length,
          total,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        suggestedQueries: [
          "Get details for course [Course ID]",
          "Build the completion report for course [Course ID]",
          `Get user by ID ${parsed.userid}`,
        ],
        fields: [
          "id",
          "fullname",
          "shortname",
          "categoryid",
          "categoryname",
          "categorypath",
          "visible",
          "completionenabled",
          "progresspct",
          "completed",
          "startdate",
          "enddate",
        ],
      },
    });
  };
}
