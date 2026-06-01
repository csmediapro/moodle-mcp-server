import { MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";
import { getCourses, getCategories } from "./cache.js";
import { searchCoursesByName } from "./search-courses-by-name.js";

export const name = "get_user_progress_report";

export const description =
  "Build a user progress report showing courses, grades, and completion status for a Moodle user. " +
  "Combines course enrollment, grade items, and activity completion status into a single report. " +
  "Use this to understand a user's progress across all their courses. " +
  "Accepts either a course ID or course name for filtering.";

export const inputSchema = z.object({
  userid: z.number().int().positive().describe("Exact Moodle user ID"),
  courseIdentifier: z.string().optional().describe("Course ID (numeric) or course name (text) to filter by"),
  includeEmptyCourses: z.boolean().optional().default(false).describe("Include courses with no grade items or completion data"),
  limitCourses: z.number().int().min(1).max(100).optional().default(25).describe("Maximum number of courses to include in the report"),
});

// Moodle API response types
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
  enablecompletion?: number;
};

type GradeItem = {
  id: number;
  itemname: string;
  gradeformatted: string;
  cmid?: number;
};

type UserGrade = {
  courseid: number;
  gradeitems: GradeItem[];
};

type ActivityCompletionStatus = {
  cmid: number;
  timecompleted?: number;
  hascompletion?: number;
  tracking?: number;
};

type ActivitiesCompletionResponse = {
  statuses?: ActivityCompletionStatus[];
};

type MoodleUser = {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  fullname?: string;
  email?: string;
  firstaccess?: number;
  lastaccess?: number;
  lastcourseaccess?: number;
};

/**
 * Sanitize HTML grade formatted text
 */
function sanitizeGrade(grade: string): string {
  // Strip HTML tags and decode entities
  let clean = grade.replace(/<[^>]*>/g, "");
  // Decode common HTML entities
  clean = clean.replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Convert "-" to blank as in the original code
  if (clean === "-") clean = "";
  return clean.trim();
}

/**
 * Format Unix timestamp to ISO string
 */
function formatTimestamp(timestamp: number | undefined): string | null {
  if (!timestamp || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Calculate completion percentage
 */
function calculateCompletionPercent(completed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((completed / total) * 100);
}

/**
 * Resolve course identifier (ID or name) to a course ID
 * @param client Moodle client
 * @param courseIdentifier Course ID (numeric string) or course name
 * @returns Resolved course ID or null if not found
 */
async function resolveCourseIdentifier(
  client: MoodleClient,
  courseIdentifier: string
): Promise<number | null> {
  // Check if it's a numeric ID
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
      userid: number;
      courseIdentifier?: string;
      includeEmptyCourses?: boolean;
      limitCourses?: number;
    };

    // Check required capabilities
    const missingCapabilities = [];
    if (!hasCapability(caps, "core_enrol_get_users_courses")) {
      missingCapabilities.push("core_enrol_get_users_courses");
    }
    if (!hasCapability(caps, "gradereport_user_get_grade_items")) {
      missingCapabilities.push("gradereport_user_get_grade_items");
    }
    if (!hasCapability(caps, "core_completion_get_activities_completion_status")) {
      missingCapabilities.push("core_completion_get_activities_completion_status");
    }

    if (missingCapabilities.length > 0) {
      return buildToolErrorResponse({
        error: {
          code: "progress_report_capability_missing",
          message: `Missing required capabilities: ${missingCapabilities.join(", ")}`,
          kind: "capability",
          canRetry: false,
          actionRequired: `Use a Moodle token/service that exposes ${missingCapabilities.join(", ")}.`,
        },
        summary: `I could not build the progress report because this Moodle token does not expose the required APIs: ${missingCapabilities.join(", ")}.`,
        meta: {
          tool: name,
          title: `User Progress Report — ${parsed.userid}`,
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

    try {
      // Get user details
      const users = await client.call<MoodleUser[]>({
        wsfunction: "core_user_get_users_by_field",
        params: {
          field: "id",
          "values[0]": String(parsed.userid),
        },
      });

      if (!users || users.length === 0) {
        return buildToolErrorResponse({
          error: {
            code: "user_not_found",
            message: `No user found with ID ${parsed.userid}`,
            kind: "not_found",
            canRetry: true,
            actionRequired: "Retry with a different user ID.",
          },
          summary: `No user found with ID ${parsed.userid}.`,
          meta: {
            tool: name,
            title: `User Progress Report — ${parsed.userid}`,
            entity: "user",
            entityId: parsed.userid,
            resultCount: 0,
          },
          suggestedQueries: [
            "Search users by lastname [Last Name]",
            "Get user by email [Exact Email]",
          ],
        });
      }

      const user = users[0];
      const fullname = user.fullname ?? `${user.firstname} ${user.lastname}`.trim();

      // Handle course identifier if provided
      let courseIdFilter: number | undefined = undefined;
      if (parsed.courseIdentifier) {
        const resolvedCourseId = await resolveCourseIdentifier(client, parsed.courseIdentifier);
        
        if (resolvedCourseId === null) {
          // Check if it's a name that resulted in multiple matches
          const courses = await getCourses(client);
          const categories = await getCategories(client);
          const matchingCourses = searchCoursesByName(courses, categories, parsed.courseIdentifier, 10);
          
          if (matchingCourses.length > 1) {
            // Return interactive selection for multiple matches
            return buildToolResponse({
              meta: {
                tool: name,
                title: `Select Course for User Progress Report — ${fullname}`,
                entity: "user",
                entityId: parsed.userid,
                resultCount: matchingCourses.length,
              },
              data: {
                kind: "table",
                title: `Multiple Courses Found — "${parsed.courseIdentifier}"`,
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
                summary: `Found ${matchingCourses.length} courses matching "${parsed.courseIdentifier}". Please select the correct course.`,
                metrics: {
                  searchTerm: parsed.courseIdentifier,
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
                    template: `get_user_progress_report ${parsed.userid} {{id}}`,
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
                message: `No course found matching "${parsed.courseIdentifier}"`,
                kind: "not_found",
                canRetry: true,
                actionRequired: "Try a different course name or use a course ID.",
              },
              summary: `No course found matching "${parsed.courseIdentifier}".`,
              meta: {
                tool: name,
                title: `User Progress Report — ${fullname}`,
                entity: "user",
                entityId: parsed.userid,
                resultCount: 0,
              },
              suggestedQueries: [
                `List courses to find the correct course ID`,
                `Search courses by name`,
              ],
            });
          }
        }
        
        courseIdFilter = resolvedCourseId;
      }

      // Get user's courses
      let userCourses = await client.call<MoodleUserCourse[]>({
        wsfunction: "core_enrol_get_users_courses",
        params: { userid: parsed.userid },
      });

      // Filter by course ID if provided
      if (courseIdFilter) {
        userCourses = userCourses.filter(course => course.id === courseIdFilter);
      }

      // Limit courses if needed
      if (parsed.limitCourses && userCourses.length > parsed.limitCourses) {
        userCourses = userCourses.slice(0, parsed.limitCourses);
      }

      if (userCourses.length === 0) {
        const courseInfo = courseIdFilter ? ` in course ${courseIdFilter}` : "";
        return buildToolResponse({
          meta: {
            tool: name,
            title: `User Progress Report — ${fullname}`,
            entity: "user",
            entityId: parsed.userid,
            resultCount: 0,
          },
          data: {
            kind: "table",
            title: `User Progress Report — ${fullname}`,
            columns: [
              { key: "course", label: "Course" },
              { key: "course_completed_pct", label: "Course Completed %" },
              { key: "item", label: "Item" },
              { key: "final_grade", label: "Final Grade" },
              { key: "completion_date", label: "Completion Date" },
            ],
            rows: [],
          },
          context: {
            summary: `${fullname} is not enrolled in any courses${courseInfo}.`,
            metrics: {
              userid: parsed.userid,
              courseCount: 0,
              reportRows: 0,
            },
            suggestedQueries: [
              `List courses for user ${parsed.userid}`,
              `Get user by ID ${parsed.userid}`,
            ],
            fields: ["course", "course_completed_pct", "item", "final_grade", "completion_date"],
          },
        });
      }

      // Process each course
      const reportRows: Array<Record<string, unknown>> = [];
      const courseSummaries: Array<{
        courseid: number;
        courseName: string;
        completedPct: number | null;
        completedItems: number;
        totalTrackedItems: number;
        hasGradeItems: boolean;
        hasCompletionStatuses: boolean;
      }> = [];
      const warnings: string[] = [];

      for (const course of userCourses) {
        try {
          // Get grade items for this course
          let gradeItems: GradeItem[] = [];
          let gradeItemsAvailable = true;
          try {
            const gradeResponse = await client.call<{ usergrades: UserGrade[] }>({
              wsfunction: "gradereport_user_get_grade_items",
              params: {
                userid: parsed.userid,
                courseid: course.id,
              },
            });

            if (gradeResponse.usergrades && gradeResponse.usergrades.length > 0) {
              gradeItems = gradeResponse.usergrades[0].gradeitems || [];
            }
          } catch (error) {
            gradeItemsAvailable = false;
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`Grade items unavailable for course ${course.id} (${course.fullname}): ${message}`);
          }

          // Get activity completion statuses
          let completionStatuses: ActivityCompletionStatus[] = [];
          let completionStatusesAvailable = true;
          try {
            const completionResponse = await client.call<ActivitiesCompletionResponse>({
              wsfunction: "core_completion_get_activities_completion_status",
              params: {
                userid: parsed.userid,
                courseid: course.id,
              },
            });

            completionStatuses = completionResponse.statuses || [];
          } catch (error) {
            completionStatusesAvailable = false;
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`Completion statuses unavailable for course ${course.id} (${course.fullname}): ${message}`);
          }

          // Create a map of completion statuses by cmid for easy lookup
          const completionMap = new Map<number, ActivityCompletionStatus>();
          for (const status of completionStatuses) {
            if (status.cmid) {
              completionMap.set(status.cmid, status);
            }
          }

          // Count tracked items for completion percentage
          const trackedStatuses = completionStatuses.filter(
            status => (status.hascompletion ?? 0) === 1 || (status.tracking ?? 0) > 0
          );
          const completedStatuses = trackedStatuses.filter(
            status => (status.timecompleted ?? 0) > 0
          );

          const totalTrackedItems = trackedStatuses.length;
          const completedItems = completedStatuses.length;
          const completedPct = calculateCompletionPercent(completedItems, totalTrackedItems);

          // Store course summary
          courseSummaries.push({
            courseid: course.id,
            courseName: course.fullname,
            completedPct,
            completedItems,
            totalTrackedItems,
            hasGradeItems: gradeItemsAvailable && gradeItems.length > 0,
            hasCompletionStatuses: completionStatusesAvailable && completionStatuses.length > 0,
          });

          // If no grade items and we're not including empty courses, skip
          if (!gradeItemsAvailable && !parsed.includeEmptyCourses) {
            continue;
          }

          // If we have grade items, create rows for each
          if (gradeItems.length > 0) {
            for (const item of gradeItems) {
              const cleanGrade = sanitizeGrade(item.gradeformatted || "");
              const completionStatus = item.cmid ? completionMap.get(item.cmid) : undefined;
              const completionDate = completionStatus?.timecompleted 
                ? formatTimestamp(completionStatus.timecompleted) 
                : null;

              reportRows.push({
                courseid: course.id,
                course: course.fullname,
                course_completed_pct: completedPct,
                itemid: item.id,
                item: item.itemname || "Unnamed Item",
                final_grade: cleanGrade,
                completion_date: completionDate,
                cmid: item.cmid || null,
              });
            }
          } else if (parsed.includeEmptyCourses) {
            // Add a row for courses with no grade items
            reportRows.push({
              courseid: course.id,
              course: course.fullname,
              course_completed_pct: completedPct,
              itemid: null,
              item: "(No grade items)",
              final_grade: "",
              completion_date: null,
              cmid: null,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Failed to process course ${course.id} (${course.fullname}): ${message}`);
        }
      }

      // Calculate overall metrics
      const totalCourses = userCourses.length;
      const coursesWithGradeItems = courseSummaries.filter(c => c.hasGradeItems).length;
      const coursesWithCompletion = courseSummaries.filter(c => c.hasCompletionStatuses).length;
      const fullyCompletedCourses = courseSummaries.filter(c => c.completedPct === 100).length;
      const notStartedCourses = courseSummaries.filter(c => c.completedPct === null || c.completedPct === 0).length;
      
      // Calculate average completion across all courses with tracked items
      const coursesWithTrackedItems = courseSummaries.filter(c => c.totalTrackedItems > 0);
      let averageCompletion = null;
      if (coursesWithTrackedItems.length > 0) {
        const totalCompletion = coursesWithTrackedItems.reduce((sum, c) => sum + (c.completedPct || 0), 0);
        averageCompletion = Math.round(totalCompletion / coursesWithTrackedItems.length);
      }

      // Build highlights
      const highlights: string[] = [];
      if (fullyCompletedCourses > 0) {
        highlights.push(`${fullyCompletedCourses} course${fullyCompletedCourses !== 1 ? 's are' : ' is'} fully completed`);
      }
      if (notStartedCourses > 0) {
        highlights.push(`${notStartedCourses} course${notStartedCourses !== 1 ? 's have' : ' has'} not been started`);
      }
      if (coursesWithGradeItems === 0) {
        highlights.push("No courses with grade items found");
      }

      const courseFilterInfo = courseIdFilter ? ` for course ${courseIdFilter}` : "";
      
      return buildToolResponse({
        meta: {
          tool: name,
          title: `User Progress Report — ${fullname}${courseFilterInfo}`,
          entity: "user",
          entityId: parsed.userid,
          resultCount: reportRows.length,
        },
        data: {
          kind: "table",
          title: `User Progress Report — ${fullname}${courseFilterInfo}`,
          columns: [
            { key: "course", label: "Course" },
            { key: "course_completed_pct", label: "Course Completed %" },
            { key: "item", label: "Item" },
            { key: "final_grade", label: "Final Grade" },
            { key: "completion_date", label: "Completion Date" },
          ],
          rows: reportRows,
        },
        context: {
          summary: 
            `${fullname} is enrolled in ${totalCourses} course${totalCourses !== 1 ? 's' : ''}` +
            (averageCompletion !== null ? ` with an average completion of ${averageCompletion}%` : "") +
            `${courseFilterInfo}. The report contains ${reportRows.length} item${reportRows.length !== 1 ? 's' : ''}.`,
          metrics: {
            userid: parsed.userid,
            totalCourses,
            coursesWithGradeItems,
            coursesWithCompletion,
            fullyCompletedCourses,
            notStartedCourses,
            averageCompletion,
            reportRows: reportRows.length,
          },
          highlights,
          warnings: warnings.length > 0 ? warnings : undefined,
          suggestedQueries: [
            `Get user by ID ${parsed.userid}`,
            `List courses for user ${parsed.userid}`,
            `Get completion report for course [Course ID]`,
          ],
          fields: [
            "courseid",
            "course",
            "course_completed_pct",
            "itemid",
            "item",
            "final_grade",
            "completion_date",
            "cmid",
          ],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildToolErrorResponse({
        error: {
          code: "progress_report_failed",
          message: `Failed to generate progress report: ${message}`,
          kind: "upstream",
          canRetry: true,
          actionRequired: "Check the Moodle API connection and try again.",
        },
        summary: `I could not generate the progress report due to an error: ${message}`,
        meta: {
          tool: name,
          title: `User Progress Report — User ${parsed.userid}`,
          entity: "user",
          entityId: parsed.userid,
          resultCount: 0,
        },
        suggestedQueries: [
          `Get user by ID ${parsed.userid}`,
          `List courses for user ${parsed.userid}`,
        ],
      });
    }
  };
}