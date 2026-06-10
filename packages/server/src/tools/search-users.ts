import { MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { logger } from "../logging/index.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";
import type { ToolColumn, ToolEntity } from "./response-types.js";
import {
  loadSchema,
  getDisplayFields,
  normalizeCustomFields,
} from "../schema/user-fields.js";

export const name = "search_users";

export const description =
  "Search Moodle users by firstname, lastname, email, username, or idnumber. " +
  "Use this for direct person lookup, not structured directory filtering or reports. " +
  "Provide at least one standard Moodle search field. Moodle performs the filtering first; this tool does not preload the full user directory. " +
  "If a directory listing plugin is installed, prefer that plugin for filter-style requests. " +
  "If multiple users match, do not guess downstream actions; select the correct user ID first.";

export const inputSchema = z.object({
  firstname: z.string().trim().min(1).optional().describe("Search by first name"),
  lastname: z.string().trim().min(1).optional().describe("Search by last name"),
  email: z.string().trim().min(1).optional().describe("Search by email"),
  username: z.string().trim().min(1).optional().describe("Search by username"),
  idnumber: z.string().trim().min(1).optional().describe("Search by ID number"),
  limit: z.number().int().min(1).max(200).optional().default(25).describe("Maximum users to return"),
  offset: z.number().int().min(0).optional().default(0).describe("Pagination offset applied after Moodle returns matches"),
}).refine(
  (value) => [value.firstname, value.lastname, value.email, value.username, value.idnumber].some((v) => v != null),
  {
    message: "Provide at least one search field",
    path: ["firstname"],
  }
);

type MoodleUser = {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  fullname?: string;
  email?: string;
  idnumber?: string;
  department?: string;
  institution?: string;
  city?: string;
  country?: string;
  firstaccess?: number;
  lastaccess?: number;
  lastcourseaccess?: number;
  suspended?: boolean;
  confirmed?: boolean;
  auth?: string;
  lang?: string;
  timezone?: string;
  description?: string;
  customfields?: Array<{
    type: string;
    value: string;
    name: string;
    shortname: string;
  }>;
};

type MoodleUserSearchResponse = {
  users?: MoodleUser[];
  warnings?: Array<{ item?: string; itemid?: number; warningcode?: string; message?: string }>;
};

const DEFAULT_USER_COLUMNS: ToolColumn[] = [
  { key: "id", label: "User ID" },
  { key: "fullname", label: "Name" },
  { key: "email", label: "Email" },
  { key: "username", label: "Username" },
  { key: "department", label: "Department" },
  { key: "institution", label: "Institution" },
  { key: "lastaccess", label: "Last Access" },
  { key: "suspended", label: "Suspended" },
];

function buildUserEntity(user: Record<string, unknown>): ToolEntity {
  const id = user.id as number;
  return {
    type: "user",
    id,
    label: typeof user.fullname === "string" ? user.fullname : `User ${id}`,
    fields: {
      email: user.email ?? null,
      username: user.username ?? null,
    },
    actions: [
      {
        label: "Progress report",
        tool: "get_user_progress_report",
        args: { userid: id },
      },
      {
        label: "List courses",
        tool: "list_user_courses",
        args: { userid: id },
      },
    ],
  };
}

export function normalizeUser(user: MoodleUser) {
  const customFields = normalizeCustomFields(user.customfields);
  const record = {
    id: user.id,
    fullname: user.fullname ?? `${user.firstname} ${user.lastname}`.trim(),
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email ?? null,
    username: user.username,
    idnumber: user.idnumber ?? null,
    department: user.department ?? null,
    institution: user.institution ?? null,
    city: user.city ?? null,
    country: user.country ?? null,
    suspended: Boolean(user.suspended),
    confirmed: user.confirmed ?? null,
    auth: user.auth ?? null,
    lang: user.lang ?? null,
    timezone: user.timezone ?? null,
    description: user.description ?? null,
    lastaccess: user.lastaccess ? new Date(user.lastaccess * 1000).toISOString() : null,
    firstaccess: user.firstaccess ? new Date(user.firstaccess * 1000).toISOString() : null,
    lastcourseaccess: user.lastcourseaccess ? new Date(user.lastcourseaccess * 1000).toISOString() : null,
  };

  return {
    ...customFields,
    ...record,
    customfields: customFields,
  };
}

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      firstname?: string;
      lastname?: string;
      email?: string;
      username?: string;
      idnumber?: string;
      limit: number;
      offset: number;
    };

    if (!hasCapability(caps, "core_user_get_users")) {
      return buildToolErrorResponse({
        error: {
          code: "user_search_capability_missing",
          message: "core_user_get_users is not available on this Moodle instance.",
          kind: "capability",
          canRetry: false,
          actionRequired: "Use a Moodle token/service that exposes core_user_get_users.",
        },
        summary: "I could not search users because this Moodle token does not expose the user search API.",
        meta: {
          tool: name,
          title: "User Search",
          entity: "user_directory",
          resultCount: 0,
        },
        suggestedQueries: [
          "Get user by email [Exact Email]",
          "List users in course [Course ID]",
        ],
      });
    }

    const criteriaEntries = [
      ["firstname", parsed.firstname],
      ["lastname", parsed.lastname],
      ["email", parsed.email],
      ["username", parsed.username],
      ["idnumber", parsed.idnumber],
    ].filter(([, value]) => value != null) as Array<[string, string]>;

    const params: Record<string, string | number> = {};
    for (const [index, [key, value]] of criteriaEntries.entries()) {
      params[`criteria[${index}][key]`] = key;
      params[`criteria[${index}][value]`] = value;
    }

    const result = await client.call<MoodleUserSearchResponse>({
      wsfunction: "core_user_get_users",
      params,
    });

    const allUsers = (result.users ?? []).map(normalizeUser);
    const pagedUsers = allUsers.slice(parsed.offset, parsed.offset + parsed.limit);
    const warnings = (result.warnings ?? []).map((warning) => warning.message).filter(Boolean) as string[];

    // Warn if Moodle rejected criteria outside the native user search fields.
    const hasInvalidFieldWarning = warnings.some((w) => w.includes("invalidfieldparameter"));
    if (hasInvalidFieldWarning) {
      warnings.push(
        "Some search criteria were ignored by Moodle. This core tool only supports Moodle-native user search fields. " +
        "For structured directory filtering, check get_capabilities for an installed directory/listing plugin.",
      );
    }

    // Load the user field schema for dynamic table columns
    const schema = loadSchema();
    const tableColumns = schema ? getDisplayFields(schema) : DEFAULT_USER_COLUMNS;

    // Collect all field keys that exist in the data (for context.fields)
    const fieldKeys = new Set<string>();
    for (const user of pagedUsers) {
      for (const key of Object.keys(user)) {
        fieldKeys.add(key);
      }
    }
    // Add custom field keys if any user has them
    for (const user of pagedUsers) {
      for (const key of Object.keys(user.customfields)) {
        fieldKeys.add(`customfields.${key}`);
      }
    }

    logger.debug("User search completed", {
      event: "search_users_completed",
      criteria: criteriaEntries.map(([key]) => key),
      totalMatches: allUsers.length,
      returned: pagedUsers.length,
      offset: parsed.offset,
      limit: parsed.limit,
      schemaUsed: !!schema,
    });

    const entities = pagedUsers.map(buildUserEntity);
    const isSingleResult = allUsers.length === 1 && pagedUsers.length === 1;

    return buildToolResponse({
      meta: {
        tool: name,
        title: isSingleResult ? `User Search Result — ${pagedUsers[0].fullname}` : "User Search Results",
        entity: isSingleResult ? "user" : "user_directory",
        ...(isSingleResult ? { entityId: pagedUsers[0].id as number } : {}),
        resultCount: pagedUsers.length,
      },
      data: {
        kind: isSingleResult ? "record" : "table",
        presentation: isSingleResult ? "compact_card" : "table",
        title: isSingleResult ? `User Search Result — ${pagedUsers[0].fullname}` : "User Search Results",
        columns: tableColumns,
        ...(isSingleResult
          ? { record: pagedUsers[0] }
          : {
              rows: pagedUsers,
              pagination: {
                offset: parsed.offset,
                limit: parsed.limit,
                total: allUsers.length,
                hasMore: parsed.offset + parsed.limit < allUsers.length,
              },
            }),
      },
      context: {
        summary:
          allUsers.length === 0
            ? "No users matched the provided search filters."
            : `Returned ${pagedUsers.length} of ${allUsers.length} matching users for the requested filters.`,
        metrics: {
          returned: pagedUsers.length,
          total_matches: allUsers.length,
          offset: parsed.offset,
          limit: parsed.limit,
          filters_applied: criteriaEntries.length,
          schema_used: !!schema,
          ...(isSingleResult ? { id: pagedUsers[0].id as number } : {}),
        },
        entities,
        ...(isSingleResult
          ? { primaryEntity: { type: "user", id: pagedUsers[0].id as number } }
          : {}),
        highlights: [
          `Filters: ${criteriaEntries.map(([key, value]) => `${key}=${value}`).join(", ")}`,
          ...(allUsers.length > parsed.limit ? [`Results were truncated to limit ${parsed.limit}.`] : []),
          ...(schema ? [] : ["No user field schema found — using default table columns. Run refresh_user_field_schema to customize."]),
        ],
        warnings: warnings.length > 0 ? warnings : undefined,
        suggestedQueries: [
          "Get user by email [Exact Email]",
          "List courses for user [User ID]",
          "List users in course [Course ID]",
        ],
        fields: [...fieldKeys].sort(),
      },
      interactions: !isSingleResult && pagedUsers.length > 0
        ? {
            mode: "row_actions",
            prompt: "Multiple users matched. Select the correct row to continue.",
            submitAs: "user_message",
            rowKey: "id",
            rowLabelFields: ["fullname", "email"],
            rowActions: [
              {
                type: "button",
                label: "Courses",
                tool: "list_user_courses",
                argsFromRow: { userid: "id" },
                style: "primary",
              },
              {
                type: "button",
                label: "Progress",
                tool: "get_user_progress_report",
                argsFromRow: { userid: "id" },
                style: "secondary",
              },
            ],
          }
        : undefined,
    });
  };
}
