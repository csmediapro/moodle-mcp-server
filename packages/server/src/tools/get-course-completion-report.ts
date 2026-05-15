import { MoodleAPIError, MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";

export const name = "get_course_completion_report";

export const description =
  "Build a joined course completion report for a Moodle course. " +
  "Combines enrolled user data with completion status so the model does not need to join results itself. " +
  "Use this for completion percentages, identifying who has not finished, and surfacing stalled learners.";

export const inputSchema = z.object({
  courseid: z.number().int().positive().describe("Moodle course ID"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(25)
    .describe("Maximum learners to include in the returned row set"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Pagination offset for the returned row set"),
});

type CourseRecord = {
  id: number;
  fullname: string;
  shortname: string;
  enablecompletion?: number;
};

type MoodleUser = {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  fullname: string;
  email: string;
  lastaccess: number;
  lastcourseaccess: number;
  roles?: Array<{ shortname: string }>;
};

type CompletionCriterion = {
  complete?: number;
  timecompleted?: number;
};

type CompletionResponse = {
  completionstatus?: {
    completed?: number;
    aggregation?: number;
    completions?: CompletionCriterion[];
  };
};

type ActivityCompletionStatus = {
  state?: number;
  timecompleted?: number;
  tracking?: number;
  hascompletion?: number;
};

type ActivitiesCompletionResponse = {
  statuses?: ActivityCompletionStatus[];
};

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }
  return results;
}

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      courseid: number;
      limit: number;
      offset: number;
    };

    if (!hasCapability(caps, "core_enrol_get_enrolled_users")) {
      return buildToolErrorResponse({
        error: "core_enrol_get_enrolled_users is not available on this Moodle instance.",
        summary:
          "I could not build the completion report because Moodle does not expose enrolled-user data to this token.",
        meta: {
          tool: name,
          title: `Completion Report — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        suggestedQueries: [
          `Check whether course [Course ID] is accessible to the API token`,
          "Ask for a narrower tool that does not require enrolment data",
        ],
      });
    }

    if (!hasCapability(caps, "core_completion_get_course_completion_status")) {
      return buildToolErrorResponse({
        error:
          "core_completion_get_course_completion_status is not available on this Moodle instance.",
        summary:
          "I could not build the completion report because this token cannot read Moodle completion status.",
        meta: {
          tool: name,
          title: `Completion Report — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        suggestedQueries: [
          `List users in course [Course ID]`,
          `Fetch details for course [Course ID]`,
        ],
      });
    }

    const courses = await client.call<CourseRecord[]>({
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
          title: `Completion Report — Course ${parsed.courseid}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        suggestedQueries: [
          "List the first [N] courses",
          `Get details for course [Course ID]`,
        ],
      });
    }

    const course = courses[0];

    const users = await client.call<MoodleUser[]>({
      wsfunction: "core_enrol_get_enrolled_users",
      params: {
        courseid: parsed.courseid,
        ...(parsed.offset
          ? {
              "options[0][name]": "limitfrom",
              "options[0][value]": parsed.offset,
            }
          : {}),
        ...(parsed.limit
          ? {
              [`options[${parsed.offset ? 1 : 0}][name]`]: "limitnumber",
              [`options[${parsed.offset ? 1 : 0}][value]`]: parsed.limit,
            }
          : {}),
      },
    });

    if (!users || users.length === 0) {
      return buildToolResponse({
        meta: {
          tool: name,
          title: `Completion Report — ${course.fullname}`,
          entity: "course",
          entityId: parsed.courseid,
          resultCount: 0,
        },
        data: {
          kind: "table",
          title: `Completion Report — ${course.fullname}`,
          columns: [
            { key: "fullname", label: "Learner" },
            { key: "email", label: "Email" },
            { key: "status", label: "Status" },
          ],
          rows: [],
          pagination: {
            offset: 0,
            limit: parsed.limit,
            total: 0,
            hasMore: false,
          },
        },
        context: {
          summary: `Course ${course.fullname} currently has no enrolled users visible to the API token.`,
          metrics: {
            courseid: parsed.courseid,
            enrolled: 0,
          },
          suggestedQueries: [
            `Get details for course [Course ID]`,
            `List assignments in course [Course ID]`,
          ],
          fields: ["fullname", "email", "status"],
        },
      });
    }

    let completionResults;
    let usedActivityFallback = false;
    try {
      completionResults = await mapInBatches(users, 10, async (user) => {
          const response = await client.call<CompletionResponse>({
            wsfunction: "core_completion_get_course_completion_status",
            params: {
              courseid: parsed.courseid,
              userid: user.id,
            },
          });

          const status = response.completionstatus;
          const criteria = status?.completions ?? [];
          const criteriaTotal = criteria.length;
          const criteriaComplete = criteria.filter((item) => item.complete === 1).length;
          const latestCompletionUnix = criteria
            .map((item) => item.timecompleted ?? 0)
            .filter((value) => value > 0)
            .sort((a, b) => b - a)[0] ?? 0;

          return {
            user,
            completed: status?.completed === 1,
            aggregation: status?.aggregation ?? null,
            criteriaTotal,
            criteriaComplete,
            progressPct:
              criteriaTotal > 0
                ? Math.round((criteriaComplete / criteriaTotal) * 100)
                : null,
            latestCompletionAt: latestCompletionUnix
              ? new Date(latestCompletionUnix * 1000).toISOString()
              : null,
          };
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof MoodleAPIError ? error.moodleError?.errorcode : undefined;
      const isPermissionIssue =
        error instanceof MoodleAPIError &&
        /not enrolled in this course|access|permission/i.test(message);
      const canUseActivityFallback =
        hasCapability(caps, "core_completion_get_activities_completion_status") &&
        (errorCode === "notenroled" || errorCode === "usernotenroled");

      if (canUseActivityFallback) {
        usedActivityFallback = true;
        completionResults = await mapInBatches(users, 10, async (user) => {
            const response = await client.call<ActivitiesCompletionResponse>({
              wsfunction: "core_completion_get_activities_completion_status",
              params: {
                courseid: parsed.courseid,
                userid: user.id,
              },
            });

            const statuses = (response.statuses ?? []).filter(
              (item) => (item.hascompletion ?? 0) === 1 || (item.tracking ?? 0) > 0
            );
            const criteriaTotal = statuses.length;
            const criteriaComplete = statuses.filter((item) =>
              [1, 2, 3].includes(item.state ?? 0)
            ).length;
            const latestCompletionUnix = statuses
              .map((item) => item.timecompleted ?? 0)
              .filter((value) => value > 0)
              .sort((a, b) => b - a)[0] ?? 0;

            return {
              user,
              completed: criteriaTotal > 0 && criteriaComplete === criteriaTotal,
              aggregation: null,
              criteriaTotal,
              criteriaComplete,
              progressPct:
                criteriaTotal > 0
                  ? Math.round((criteriaComplete / criteriaTotal) * 100)
                  : null,
              latestCompletionAt: latestCompletionUnix
                ? new Date(latestCompletionUnix * 1000).toISOString()
                : null,
            };
          });
      } else {

        return buildToolErrorResponse({
          error: {
            code: isPermissionIssue
              ? "moodle_completion_access_denied"
              : "moodle_completion_report_failed",
            message,
            kind: isPermissionIssue ? "permission" : "upstream",
            canRetry: false,
            actionRequired: isPermissionIssue
              ? "Enroll the API user in the course or grant the reporting capability needed to read course completion status."
              : "Review the Moodle API token permissions and retry after the upstream issue is resolved.",
          },
          summary: isPermissionIssue
            ? "I could not build the completion report because the authenticated API user does not have permission to read course completion status for this course."
            : "I could not build the completion report because Moodle rejected the completion-status request.",
          meta: {
            tool: name,
            title: `Completion Report — ${course.fullname}`,
            entity: "course",
            entityId: parsed.courseid,
            resultCount: 0,
          },
          highlights: [
            "The course exists and the report tool reached the completion-status API.",
            isPermissionIssue
              ? "The failure is access-related, not a missing-course error."
              : "The failure happened while asking Moodle for per-user completion status.",
          ],
          warnings: [
            isPermissionIssue
              ? "Moodle is evaluating this request using the API user's course-level permissions, not as a global reporting action."
              : "This error came from Moodle, not from the MCP transport layer.",
          ],
          suggestedQueries: [
            `List users in course [Course ID]`,
            `List assignments in course [Course ID]`,
            `What recent activity is happening in course [Course ID]?`,
          ],
        });
      }
    }

    const joinedRows = completionResults.map((item) => {
      const hasStarted = (item.progressPct ?? 0) > 0 || !!item.user.lastcourseaccess;
      return {
        userid: item.user.id,
        fullname: item.user.fullname,
        email: item.user.email || null,
        username: item.user.username,
        status: item.completed
          ? "Completed"
          : hasStarted
            ? "In Progress"
            : "Not Started",
        progress_pct: item.progressPct,
        criteria_complete: item.criteriaComplete,
        criteria_total: item.criteriaTotal,
        completed_at: item.latestCompletionAt,
        last_course_access: item.user.lastcourseaccess
          ? new Date(item.user.lastcourseaccess * 1000).toISOString()
          : "never",
        last_site_access: item.user.lastaccess
          ? new Date(item.user.lastaccess * 1000).toISOString()
          : "never",
        roles: item.user.roles?.map((role) => role.shortname).join(", ") || "unknown",
      };
    });

    const completedCount = joinedRows.filter((row) => row.status === "Completed").length;
    const inProgressCount = joinedRows.filter((row) => row.status === "In Progress").length;
    const notStartedCount = joinedRows.filter((row) => row.status === "Not Started").length;
    const completionPct = Math.round((completedCount / joinedRows.length) * 100);
    const neverStartedNames = joinedRows
      .filter((row) => row.status === "Not Started")
      .slice(0, 3)
      .map((row) => row.fullname);

    const warnings: string[] = [];
    if (course.enablecompletion !== 1) {
      warnings.push(
        "This course does not appear to have course completion tracking enabled. Results may be sparse or misleading."
      );
    }
    if (usedActivityFallback) {
      warnings.push(
        "This report was derived from per-activity completion because Moodle's official course-completion endpoint rejected the API user unless it is enrolled in the course."
      );
    }

    return buildToolResponse({
      meta: {
        tool: name,
        title: `Completion Report — ${course.fullname}`,
        entity: "course",
        entityId: parsed.courseid,
        resultCount: joinedRows.length,
      },
      data: {
        kind: "table",
        title: `Completion Report — ${course.fullname}`,
        columns: [
          { key: "fullname", label: "Learner" },
          { key: "email", label: "Email" },
          { key: "status", label: "Status" },
          { key: "progress_pct", label: "Progress %" },
          { key: "completed_at", label: "Completed At" },
          { key: "last_course_access", label: "Last Course Access" },
        ],
        rows: joinedRows,
        pagination: {
          offset: parsed.offset,
          limit: parsed.limit,
          total: joinedRows.length,
          hasMore: joinedRows.length === parsed.limit,
        },
      },
      context: {
        summary: usedActivityFallback
          ? `${completedCount} of ${joinedRows.length} returned learners appear fully complete on tracked activities in ${course.fullname} ` +
            `(${completionPct}%). ${inProgressCount} are in progress and ${notStartedCount} have not started.`
          : `${completedCount} of ${joinedRows.length} returned learners have completed ${course.fullname} ` +
            `(${completionPct}%). ${inProgressCount} are in progress and ${notStartedCount} have not started.`,
        metrics: {
          courseid: parsed.courseid,
          returned: joinedRows.length,
          completed: completedCount,
          in_progress: inProgressCount,
          not_started: notStartedCount,
          completion_pct: completionPct,
          activity_fallback: usedActivityFallback,
        },
        highlights: [
          ...(usedActivityFallback
            ? [
                "This course-level view is using activity completion as a fallback proxy because the official course-completion endpoint rejects the API user unless it is enrolled.",
              ]
            : []),
          ...(notStartedCount > 0 && neverStartedNames.length > 0
            ? [
                `Not started yet: ${neverStartedNames.join(", ")}${notStartedCount > neverStartedNames.length ? ", …" : ""}`,
              ]
            : []),
          ...(inProgressCount > 0
            ? [`${inProgressCount} learners are partway through the course and may need a follow-up.`]
            : []),
        ],
        suggestedQueries: [
          `Show learners in course [Course ID] who have not started`,
          `List assignments in course [Course ID]`,
          `What recent activity is happening in course [Course ID]?`,
        ],
        fields: [
          "userid",
          "fullname",
          "email",
          "status",
          "progress_pct",
          "completed_at",
          "last_course_access",
          "roles",
        ],
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    });
  };
}
