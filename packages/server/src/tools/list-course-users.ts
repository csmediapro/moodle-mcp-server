import { MoodleAPIError, MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";
import { getCategories, getCourses } from "./cache.js";

/**
 * list_course_users — List users enrolled in a specific course or category.
 *
 * Uses core_enrol_get_enrolled_users which returns full user profiles
 * including department, institution, access timestamps, and groups.
 * Category mode aggregates across all courses in the category and
 * deduplicates users by Moodle user ID.
 */
export const name = "list_course_users";

export const description =
  "List enrolled users in a specific Moodle course or across all courses in a specific LMS category. " +
  "Provide exactly one of courseid or categoryid. " +
  "Returns user ID, full name, email, department, institution, " +
  "last access timestamps, and enrollment roles. " +
  "Category mode deduplicates overlapping users across courses before returning results. " +
  "Use an exact category ID from list_categories when working at category scope.";

export const inputSchema = z.object({
  /** Course ID */
  courseid: z.number().int().positive().optional().describe("Moodle course ID"),
  /** Category ID */
  categoryid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("LMS category ID. Aggregates enrolled users across all courses in the category."),
  /** Optional: max users to return (default 100, max 500) */
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe("Maximum users to return"),
  /** Optional: pagination offset */
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Pagination offset"),
}).refine((value) => (value.courseid == null) !== (value.categoryid == null), {
  message: "Provide exactly one of courseid or categoryid",
  path: ["courseid"],
});

type EnrolledUser = {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  fullname: string;
  email: string;
  department: string;
  institution: string;
  idnumber: string;
  lastaccess: number;
  lastcourseaccess: number;
  firstaccess: number;
  city: string;
  country: string;
  groups: Array<{ id: number; name: string }>;
  roles: Array<{ roleid: number; shortname: string }>;
  courseids?: number[];
  coursenames?: string[];
};

async function fetchCourseUsers(
  client: MoodleClient,
  courseid: number,
  offset: number,
  limit: number,
) {
  return client.call<Array<EnrolledUser>>({
    wsfunction: "core_enrol_get_enrolled_users",
    params: {
      courseid,
      ...(offset
        ? {
            "options[0][name]": "limitfrom",
            "options[0][value]": offset,
          }
        : {}),
      ...(limit
        ? {
            [`options[${offset ? 1 : 0}][name]`]: "limitnumber",
            [`options[${offset ? 1 : 0}][value]`]: limit,
          }
        : {}),
    },
  });
}

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      courseid?: number;
      categoryid?: number;
      limit: number;
      offset: number;
    };

    const available = hasCapability(caps, "core_enrol_get_enrolled_users");
    if (!available) {
      return buildToolErrorResponse({
        error:
          "core_enrol_get_enrolled_users is not available on this Moodle instance. " +
          "The API token may lack the required capabilities.",
        summary:
          "I could not list enrolled users because this Moodle token does not expose the enrolled-user API.",
        meta: {
          tool: name,
          title: parsed.courseid != null
            ? `Enrolled Users — Course ${parsed.courseid}`
            : `Enrolled Users — Category ${parsed.categoryid}`,
          entity: parsed.courseid != null ? "course" : "course_category",
          entityId: parsed.courseid ?? parsed.categoryid,
          resultCount: 0,
        },
        suggestedQueries: [
          `Get course details for [Course ID]`,
          `List categories and use the exact category ID`,
          `List assignments in course [Course ID]`,
        ],
      });
    }

    let users: Array<EnrolledUser>;
    try {
      if (parsed.courseid != null) {
        users = await fetchCourseUsers(client, parsed.courseid, parsed.offset, parsed.limit);
      } else {
        const [courses, categories] = await Promise.all([
          getCourses(client),
          getCategories(client),
        ]);
        const category = categories.find((c) => c.id === parsed.categoryid);

        if (!category) {
          return buildToolErrorResponse({
            error: `Category ${parsed.categoryid} not found or not accessible`,
            summary: `Category ${parsed.categoryid} was not found or is not visible to the API token.`,
            meta: {
              tool: name,
              title: `Enrolled Users — Category ${parsed.categoryid}`,
              entity: "course_category",
              entityId: parsed.categoryid,
              resultCount: 0,
            },
            suggestedQueries: [
              "List categories and use the exact category ID",
              "List top-level categories",
            ],
          });
        }

        const categoryCourses = courses.filter((c) => c.categoryid === parsed.categoryid);
        if (categoryCourses.length === 0) {
          return buildToolResponse({
            meta: {
              tool: name,
              title: `Enrolled Users — Category ${category.name}`,
              entity: "course_category",
              entityId: parsed.categoryid,
              resultCount: 0,
            },
            data: {
              kind: "table",
              title: `Enrolled Users — Category ${category.name}`,
              columns: [
                { key: "id", label: "User ID" },
                { key: "fullname", label: "Name" },
                { key: "email", label: "Email" },
                { key: "department", label: "Department" },
                { key: "institution", label: "Institution" },
                { key: "lastcourseaccess", label: "Last Course Access" },
                { key: "roles", label: "Roles" },
              ],
              rows: [],
              pagination: {
                offset: parsed.offset,
                limit: parsed.limit,
                total: 0,
                hasMore: false,
              },
            },
            context: {
              summary: `Category ${category.name} contains no visible courses, so there are no enrolled users to aggregate.`,
              metrics: {
                course_count: 0,
                returned: 0,
                total_unique_users: 0,
                duplicate_enrollments_collapsed: 0,
              },
              suggestedQueries: [
                "List categories with no courses",
                "List the first [N] courses",
              ],
              fields: ["id", "fullname", "email", "department", "institution", "lastcourseaccess", "roles"],
            },
          });
        }

        const perCourseUsers = await Promise.all(
          categoryCourses.map(async (course) => ({
            courseid: course.id,
            coursename: course.fullname,
            users: await fetchCourseUsers(client, course.id, 0, 500),
          })),
        );

        const dedupedUsers = new Map<number, EnrolledUser & { courseids: number[]; coursenames: string[] }>();
        let totalEnrollmentsScanned = 0;

        for (const course of perCourseUsers) {
          totalEnrollmentsScanned += course.users.length;
          for (const user of course.users) {
            const existing = dedupedUsers.get(user.id);
            if (existing) {
              if (!existing.courseids.includes(course.courseid)) {
                existing.courseids.push(course.courseid);
                existing.coursenames.push(course.coursename);
              }

              const mergedGroups = new Map(existing.groups.map((group) => [group.id, group]));
              for (const group of user.groups ?? []) mergedGroups.set(group.id, group);
              existing.groups = Array.from(mergedGroups.values());

              const mergedRoles = new Map(existing.roles.map((role) => [role.roleid, role]));
              for (const role of user.roles ?? []) mergedRoles.set(role.roleid, role);
              existing.roles = Array.from(mergedRoles.values());

              existing.lastaccess = Math.max(existing.lastaccess ?? 0, user.lastaccess ?? 0);
              existing.lastcourseaccess = Math.max(existing.lastcourseaccess ?? 0, user.lastcourseaccess ?? 0);
              existing.firstaccess = existing.firstaccess && user.firstaccess
                ? Math.min(existing.firstaccess, user.firstaccess)
                : existing.firstaccess || user.firstaccess;
            } else {
              dedupedUsers.set(user.id, {
                ...user,
                groups: [...(user.groups ?? [])],
                roles: [...(user.roles ?? [])],
                courseids: [course.courseid],
                coursenames: [course.coursename],
              });
            }
          }
        }

        users = Array.from(dedupedUsers.values())
          .sort((a, b) => a.fullname.localeCompare(b.fullname))
          .slice(parsed.offset, parsed.offset + parsed.limit);

        const rows = users.map((u) => ({
          id: u.id,
          username: u.username,
          firstname: u.firstname,
          lastname: u.lastname,
          fullname: u.fullname,
          email: u.email,
          department: u.department || null,
          institution: u.institution || null,
          idnumber: u.idnumber || null,
          city: u.city || null,
          country: u.country || null,
          lastaccess: u.lastaccess ? new Date(u.lastaccess * 1000).toISOString() : "never",
          lastcourseaccess: u.lastcourseaccess
            ? new Date(u.lastcourseaccess * 1000).toISOString()
            : "never",
          firstaccess: u.firstaccess
            ? new Date(u.firstaccess * 1000).toISOString()
            : "never",
          groups: u.groups?.map((g) => g.name) ?? [],
          roles: u.roles?.map((r) => r.shortname) ?? [],
          courseids: u.courseids ?? [],
          coursecount: (u.courseids ?? []).length,
          coursenames: u.coursenames ?? [],
        }));

        const totalUniqueUsers = dedupedUsers.size;
        const duplicateEnrollmentsCollapsed = totalEnrollmentsScanned - totalUniqueUsers;
        const neverAccessed = rows.filter((row) => row.lastcourseaccess === "never").length;
        const roleCounts = rows.reduce<Record<string, number>>((acc, row) => {
          for (const role of row.roles as string[]) {
            acc[role] = (acc[role] ?? 0) + 1;
          }
          return acc;
        }, {});

        return buildToolResponse({
          meta: {
            tool: name,
            title: `Enrolled Users — Category ${category.name}`,
            entity: "course_category",
            entityId: parsed.categoryid,
            resultCount: rows.length,
          },
          data: {
            kind: "table",
            title: `Enrolled Users — Category ${category.name}`,
            columns: [
              { key: "id", label: "User ID" },
              { key: "fullname", label: "Name" },
              { key: "email", label: "Email" },
              { key: "department", label: "Department" },
              { key: "institution", label: "Institution" },
              { key: "coursecount", label: "Courses" },
              { key: "lastcourseaccess", label: "Last Course Access" },
              { key: "roles", label: "Roles" },
            ],
            rows,
            pagination: {
              offset: parsed.offset,
              limit: parsed.limit,
              total: totalUniqueUsers,
              hasMore: parsed.offset + parsed.limit < totalUniqueUsers,
            },
          },
          context: {
            summary:
              `Returned ${rows.length} unique enrolled users across ${categoryCourses.length} courses in category ${category.name}. ` +
              `${duplicateEnrollmentsCollapsed} duplicate course enrollments were collapsed.`,
            metrics: {
              returned: rows.length,
              total_unique_users: totalUniqueUsers,
              total_enrollments_scanned: totalEnrollmentsScanned,
              duplicate_enrollments_collapsed: duplicateEnrollmentsCollapsed,
              course_count: categoryCourses.length,
              never_accessed: neverAccessed,
              offset: parsed.offset,
              limit: parsed.limit,
            },
            highlights: [
              `Category path: ${category.path}`,
              `Scanned course IDs: ${categoryCourses.map((course) => course.id).join(", ")}`,
              ...(Object.keys(roleCounts).length > 0
                ? [
                    `Role mix: ${Object.entries(roleCounts)
                      .map(([role, count]) => `${role} ${count}`)
                      .join(", ")}`,
                  ]
                : []),
            ],
            suggestedQueries: [
              "List categories and use the exact category ID",
              `Build the completion report for course [Course ID]`,
              `List assignments in course [Course ID]`,
            ],
            fields: [
              "id",
              "username",
              "firstname",
              "lastname",
              "fullname",
              "email",
              "department",
              "institution",
              "lastcourseaccess",
              "roles",
              "courseids",
              "coursecount",
              "coursenames",
            ],
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isParameterIssue =
        error instanceof MoodleAPIError && /invalid parameter value detected/i.test(message);

      return buildToolErrorResponse({
        error: {
          code: isParameterIssue
            ? "moodle_enrolled_users_invalid_parameter"
            : "moodle_enrolled_users_failed",
          message,
          kind: isParameterIssue ? "validation" : "upstream",
          canRetry: false,
          actionRequired: isParameterIssue
            ? "Check the course enrollment configuration and the API user's enrolment-related permissions, then retry."
            : "Review the Moodle API token permissions and retry after the upstream issue is resolved.",
        },
        summary: isParameterIssue
          ? "I could not list enrolled users because Moodle rejected the enrollment-user request with an invalid-parameter error."
          : "I could not list enrolled users because Moodle rejected the enrollment-user request.",
        meta: {
          tool: name,
          title: parsed.courseid != null
            ? `Enrolled Users — Course ${parsed.courseid}`
            : `Enrolled Users — Category ${parsed.categoryid}`,
          entity: parsed.courseid != null ? "course" : "course_category",
          entityId: parsed.courseid ?? parsed.categoryid,
          resultCount: 0,
        },
        highlights: [
          "The course lookup can still succeed even though the enrolled-user endpoint failed.",
          isParameterIssue
            ? "This looks like a Moodle-side validation or permissions/configuration issue."
            : "This failure came from Moodle, not the MCP transport layer.",
        ],
        warnings: [
          isParameterIssue
            ? "Some Moodle instances surface permission or enrolment-method problems as a generic invalid-parameter error."
            : "The enrolled-user endpoint did not return a usable payload.",
        ],
        suggestedQueries: [
          `Get course details for [Course ID]`,
          `List categories and use the exact category ID`,
          `List assignments in course [Course ID]`,
          `What recent activity is happening in course [Course ID]?`,
        ],
      });
    }

    const rows = users.map((u) => ({
        id: u.id,
        username: u.username,
        firstname: u.firstname,
        lastname: u.lastname,
        fullname: u.fullname,
        email: u.email,
        department: u.department || null,
        institution: u.institution || null,
        idnumber: u.idnumber || null,
        city: u.city || null,
        country: u.country || null,
        lastaccess: u.lastaccess ? new Date(u.lastaccess * 1000).toISOString() : "never",
        lastcourseaccess: u.lastcourseaccess
          ? new Date(u.lastcourseaccess * 1000).toISOString()
          : "never",
        firstaccess: u.firstaccess
          ? new Date(u.firstaccess * 1000).toISOString()
          : "never",
        groups: u.groups?.map((g) => g.name) ?? [],
        roles: u.roles?.map((r) => r.shortname) ?? [],
      }));

    const neverAccessed = rows.filter(
      (row) => row.lastcourseaccess === "never"
    ).length;
    const roleCounts = rows.reduce<Record<string, number>>((acc, row) => {
      for (const role of row.roles) {
        acc[role] = (acc[role] ?? 0) + 1;
      }
      return acc;
    }, {});

    return buildToolResponse({
      meta: {
        tool: name,
        title: `Enrolled Users — Course ${parsed.courseid}`,
        entity: "course",
        entityId: parsed.courseid,
        resultCount: rows.length,
      },
      data: {
        kind: "table",
        title: `Enrolled Users — Course ${parsed.courseid}`,
        columns: [
          { key: "id", label: "User ID" },
          { key: "fullname", label: "Name" },
          { key: "email", label: "Email" },
          { key: "department", label: "Department" },
          { key: "institution", label: "Institution" },
          { key: "lastcourseaccess", label: "Last Course Access" },
          { key: "roles", label: "Roles" },
        ],
        rows,
        pagination: {
          offset: parsed.offset,
          limit: parsed.limit,
          total: rows.length,
          hasMore: rows.length === parsed.limit,
        },
      },
      context: {
        summary:
          `Returned ${rows.length} enrolled users for course ${parsed.courseid}. ` +
          `${neverAccessed} have never accessed the course.`,
        metrics: {
          returned: rows.length,
          never_accessed: neverAccessed,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        highlights:
          Object.keys(roleCounts).length > 0
            ? [
                `Role mix: ${Object.entries(roleCounts)
                  .map(([role, count]) => `${role} ${count}`)
                  .join(", ")}`,
              ]
            : undefined,
        suggestedQueries: [
          `Show completion report for course [Course ID]`,
          `List categories and use the exact category ID`,
          `List assignments in course [Course ID]`,
          `Show recent activity in course [Course ID]`,
        ],
        fields: [
          "id",
          "username",
          "firstname",
          "lastname",
          "fullname",
          "email",
          "department",
          "institution",
          "lastcourseaccess",
          "roles",
        ],
      },
    });
  };
}
