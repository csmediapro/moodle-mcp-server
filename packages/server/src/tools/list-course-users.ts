import { MoodleAPIError, MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";
import { extractSilo, filterUsersBySilo } from "./silo.js";
import { getCategories, getCourses } from "./cache.js";
import { searchCoursesByName } from "./search-courses-by-name.js";

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
  "Provide exactly one of courseid, coursename, or categoryid. " +
  "Returns user ID, full name, email, department, institution, " +
  "last access timestamps, and enrollment roles. " +
  "Category mode deduplicates overlapping users across courses before returning results. " +
  "Use an exact category ID from list_categories when working at category scope.";

export const inputSchema = z.object({
  /** Course ID (numeric) */
  courseid: z.number().int().positive().optional().describe("Moodle course ID"),
  /** Course name (text) */
  coursename: z.string().optional().describe("Moodle course name for partial matching"),
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
  /** Internal: silo constraint injected by agent-edge for sub-users */
  _silo: z.object({
    field: z.string(),
    value: z.string(),
  }).optional().describe("INTERNAL: Silo filter injected by agent-edge. Not for direct use."),
}).refine((value) => {
  const provided = [value.courseid, value.coursename, value.categoryid].filter(v => v != null).length;
  return provided === 1;
}, {
  message: "Provide exactly one of courseid, coursename, or categoryid",
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
  customfields?: Array<{
    type?: string;
    value: string | number | boolean | null;
    name?: string;
    shortname: string;
  }>;
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

/**
 * Resolve course identifier (ID or name) to a course ID
 * @param client Moodle client
 * @param courseIdentifier Course ID (numeric) or course name
 * @returns Resolved course ID or null if not found
 */
async function resolveCourseIdentifier(
  client: MoodleClient,
  courseIdentifier: string | number
): Promise<number | null> {
  // Check if it's a numeric ID
  if (typeof courseIdentifier === 'number') {
    return courseIdentifier;
  }
  
  const courseId = parseInt(courseIdentifier, 10);
  if (!isNaN(courseId) && courseId > 0) {
    return courseId;
  }

  // It's a course name, search for it
  const courses = await getCourses(client);
  const categories = await getCategories(client);
  
  const matchingCourses = searchCoursesByName(courses, categories, courseIdentifier, 10);
  
  if (matchingCourses.length === 0) {
    return null; // No matches found
  }
  
  if (matchingCourses.length === 1) {
    return matchingCourses[0].id; // Return the single match
  }
  
  // Multiple matches - this should be handled by the calling function
  return null;
}

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      courseid?: number;
      coursename?: string;
      categoryid?: number;
      limit: number;
      offset: number;
      _silo?: { field: string; value: string };
    };

    const silo = extractSilo(parsed as unknown as Record<string, unknown>);

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
          title: parsed.courseid != null || parsed.coursename != null
            ? `Enrolled Users — Course ${parsed.courseid ?? parsed.coursename}`
            : `Enrolled Users — Category ${parsed.categoryid}`,
          entity: parsed.courseid != null || parsed.coursename != null ? "course" : "course_category",
          entityId: parsed.categoryid,
          resultCount: 0,
        },
        suggestedQueries: [
          `Get course details for [Course ID]`,
          `List categories and use the exact category ID`,
          `List assignments in course [Course ID]`,
        ],
      });
    }

    // Handle course name resolution if provided
    let resolvedCourseId: number | undefined = undefined;
    if (parsed.coursename) {
      const resolvedId = await resolveCourseIdentifier(client, parsed.coursename);
      
      if (resolvedId === null) {
        // Check if it's a name that resulted in multiple matches
        const courses = await getCourses(client);
        const categories = await getCategories(client);
        const matchingCourses = searchCoursesByName(courses, categories, parsed.coursename, 10);
        
        if (matchingCourses.length > 1) {
          // Return interactive selection for multiple matches
          return buildToolResponse({
            meta: {
              tool: name,
              title: `Select Course for User List`,
              entity: "course",
              resultCount: matchingCourses.length,
            },
            data: {
              kind: "table",
              title: `Multiple Courses Found — "${parsed.coursename}"`,
              columns: [
                { key: "id", label: "Course ID" },
                { key: "fullname", label: "Full Name" },
                { key: "shortname", label: "Short Name" },
                { key: "categoryname", label: "Category" },
                { key: "visible", label: "Visible" },
              ],
              rows: matchingCourses,
            },
            context: {
              summary: `Found ${matchingCourses.length} courses matching "${parsed.coursename}". Please select the correct course.`,
              metrics: {
                searchTerm: parsed.coursename,
                returned: matchingCourses.length,
                total: matchingCourses.length,
              },
              fields: ["id", "fullname", "shortname", "categoryname", "visible"],
            },
            interactions: {
              mode: "row_actions",
              prompt: "Multiple courses matched. Select the correct course to continue.",
              submitAs: "user_message",
              rowKey: "id",
              rowLabelFields: ["fullname", "shortname"],
              rowActions: [
                {
                  type: "button",
                  label: "Select",
                  template: `list_course_users {{id}}`,
                  style: "primary",
                },
              ],
            },
          });
        } else {
          // No matches found
          return buildToolErrorResponse({
            error: {
              code: "course_not_found",
              message: `No course found matching "${parsed.coursename}"`,
              kind: "not_found",
              canRetry: true,
              actionRequired: "Try a different course name or use a course ID.",
            },
            summary: `No course found matching "${parsed.coursename}".`,
            meta: {
              tool: name,
              title: `Enrolled Users — Course Search`,
              entity: "course",
              resultCount: 0,
            },
            suggestedQueries: [
              `List courses to find the correct course ID`,
              `Search courses by name`,
            ],
          });
        }
      }
      
      resolvedCourseId = resolvedId;
    }

    let users: Array<EnrolledUser>;
    let totalForPagination: number | null = null;
    try {
      if (parsed.courseid != null || resolvedCourseId != null) {
        const courseId = parsed.courseid ?? resolvedCourseId!;
        if (silo) {
          const allUsers = await fetchCourseUsers(client, courseId, 0, 0);
          const filteredUsers = filterUsersBySilo(allUsers, silo);
          totalForPagination = filteredUsers.length;
          users = filteredUsers.slice(parsed.offset, parsed.offset + parsed.limit);
        } else {
          users = await fetchCourseUsers(client, courseId, parsed.offset, parsed.limit);
        }
      } else if (parsed.categoryid != null) {
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

        const totalDedupedUsers = dedupedUsers.size;
        const filteredUsers = filterUsersBySilo(Array.from(dedupedUsers.values()), silo)
          .sort((a, b) => a.fullname.localeCompare(b.fullname));
        users = filteredUsers.slice(parsed.offset, parsed.offset + parsed.limit);

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

        const totalUniqueUsers = filteredUsers.length;
        const duplicateEnrollmentsCollapsed = totalEnrollmentsScanned - totalDedupedUsers;
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
      } else {
        // This should not happen due to validation, but just in case
        return buildToolErrorResponse({
          error: "Invalid parameters: must provide courseid, coursename, or categoryid",
          summary: "Invalid parameters provided to list_course_users",
          meta: {
            tool: name,
            title: "Enrolled Users",
            resultCount: 0,
          },
          suggestedQueries: [
            "List courses to find the correct course ID",
            "List categories and use the exact category ID",
          ],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isParameterIssue =
        error instanceof MoodleAPIError && /invalid parameter value detected/i.test(message);

      const courseIdForMeta = parsed.courseid ?? resolvedCourseId;
      
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
          title: parsed.courseid != null || resolvedCourseId != null
            ? `Enrolled Users — Course ${courseIdForMeta}`
            : `Enrolled Users — Category ${parsed.categoryid}`,
          entity: parsed.courseid != null || resolvedCourseId != null ? "course" : "course_category",
          entityId: parsed.categoryid,
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

    const courseIdForTitle = parsed.courseid ?? resolvedCourseId;
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
        title: `Enrolled Users — Course ${courseIdForTitle}`,
        entity: "course",
        entityId: courseIdForTitle,
        resultCount: rows.length,
      },
      data: {
        kind: "table",
        title: `Enrolled Users — Course ${courseIdForTitle}`,
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
          total: totalForPagination ?? rows.length,
          hasMore: totalForPagination != null
            ? parsed.offset + parsed.limit < totalForPagination
            : rows.length === parsed.limit,
        },
      },
      context: {
        summary:
          `Returned ${rows.length} enrolled users for course ${courseIdForTitle}. ` +
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
