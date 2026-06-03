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

export const name = "get_user";

export const description =
  "Fetch one Moodle user by exact ID, email, or username. " +
  "Provide exactly one of id, email, or username. " +
  "Returns a single structured user record including any custom profile fields.";

export const inputSchema = z.object({
  id: z.number().int().positive().optional().describe("Exact Moodle user ID"),
  email: z.string().trim().email().optional().describe("Exact email address"),
  username: z.string().trim().min(1).optional().describe("Exact Moodle username"),
  presentation: z.enum(["compact", "full"]).optional().default("compact").describe("How much user detail to display. Use compact for workflow steps and full when explicitly asked for all user details."),
}).refine((value) => [value.id, value.email, value.username].filter((v) => v != null).length === 1, {
  message: "Provide exactly one of id, email, or username",
  path: ["id"],
});

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
  descriptionformat?: number;
  phone2?: string;
  customfields?: Array<{
    type: string;
    value: string;
    name: string;
    shortname: string;
  }>;
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

function normalizeUser(user: MoodleUser, customFields: Record<string, string | boolean | null>) {
  return {
    ...customFields,
    id: user.id,
    username: user.username,
    firstname: user.firstname,
    lastname: user.lastname,
    fullname: user.fullname ?? `${user.firstname} ${user.lastname}`.trim(),
    email: user.email ?? null,
    idnumber: user.idnumber ?? null,
    department: user.department ?? null,
    institution: user.institution ?? null,
    city: user.city ?? null,
    country: user.country ?? null,
    auth: user.auth ?? null,
    suspended: Boolean(user.suspended),
    confirmed: user.confirmed ?? null,
    lang: user.lang ?? null,
    timezone: user.timezone ?? null,
    description: user.description ?? null,
    phone2: user.phone2 ?? null,
    firstaccess: user.firstaccess ? new Date(user.firstaccess * 1000).toISOString() : null,
    lastaccess: user.lastaccess ? new Date(user.lastaccess * 1000).toISOString() : null,
    lastcourseaccess: user.lastcourseaccess ? new Date(user.lastcourseaccess * 1000).toISOString() : null,
  };
}

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      id?: number;
      email?: string;
      username?: string;
      presentation: "compact" | "full";
    };

    if (!hasCapability(caps, "core_user_get_users_by_field")) {
      return buildToolErrorResponse({
        error: {
          code: "user_lookup_capability_missing",
          message: "core_user_get_users_by_field is not available on this Moodle instance.",
          kind: "capability",
          canRetry: false,
          actionRequired: "Use a Moodle token/service that exposes core_user_get_users_by_field.",
        },
        summary: "I could not look up a user because this Moodle token does not expose the exact user lookup API.",
        meta: {
          tool: name,
          title: "User Lookup",
          entity: "user_directory",
          resultCount: 0,
        },
        suggestedQueries: [
          "Search users by lastname [Last Name]",
          "List users in course [Course ID]",
        ],
      });
    }

    const field =
      parsed.id != null ? "id" :
      parsed.email != null ? "email" :
      "username";
    const value =
      parsed.id != null ? String(parsed.id) :
      parsed.email != null ? parsed.email :
      parsed.username as string;

    const users = await client.call<MoodleUser[]>({
      wsfunction: "core_user_get_users_by_field",
      params: {
        field,
        "values[0]": value,
      },
    });

    logger.debug("User lookup completed", {
      event: "get_user_lookup",
      lookupField: field,
      matchCount: users.length,
    });

    if (!users || users.length === 0) {
      return buildToolErrorResponse({
        error: {
          code: "user_not_found",
          message: `No user matched ${field}=${value}.`,
          kind: "not_found",
          canRetry: true,
          actionRequired: "Retry with a different exact ID, email, or username, or use search_users for broader matching.",
        },
        summary: `No user matched the provided ${field}.`,
        meta: {
          tool: name,
          title: "User Lookup",
          entity: "user_directory",
          resultCount: 0,
        },
        suggestedQueries: [
          "Search users by lastname [Last Name]",
          "Search users by email [Email Fragment or Exact Email]",
        ],
      });
    }

    if (users.length > 1) {
      logger.warn("Exact user lookup returned multiple matches", {
        event: "get_user_multiple_matches",
        lookupField: field,
        matchCount: users.length,
      });
    }

    const customFields = normalizeCustomFields(users[0].customfields);
    const record = normalizeUser(users[0], customFields);
    const hasCustomFields = Object.keys(customFields).length > 0;
    const schema = loadSchema();
    const displayColumns = schema ? getDisplayFields(schema) : DEFAULT_USER_COLUMNS;
    const entity = buildUserEntity(record);
    const presentation = parsed.presentation === "full" ? "full_card" : "compact_card";

    return buildToolResponse({
      meta: {
        tool: name,
        title: `User Details — ${record.fullname}`,
        entity: "user",
        entityId: record.id,
        resultCount: 1,
      },
      data: {
        kind: "record",
        presentation,
        title: `User Details — ${record.fullname}`,
        ...(presentation === "compact_card" ? { columns: displayColumns } : {}),
        record,
      },
      context: {
        summary:
          record.lastaccess
            ? `${record.fullname} was found and has logged into Moodle before.` +
              (hasCustomFields ? ` Custom profile fields are available.` : "")
            : `${record.fullname} was found, but there is no recorded Moodle access timestamp yet.`,
        metrics: {
          id: record.id,
          suspended: record.suspended,
          confirmed: record.confirmed,
          ...(hasCustomFields ? { customFieldCount: Object.keys(customFields).length } : {}),
          schema_used: !!schema,
        },
        primaryEntity: { type: "user", id: record.id },
        entities: [entity],
        highlights: [
          `Lookup field: ${field}`,
          ...(hasCustomFields
            ? [`Custom fields: ${Object.entries(customFields).map(([k, v]) => `${k}=${v}`).join(", ")}`]
            : []),
        ],
        suggestedQueries: [
          `List courses for user ${record.id}`,
          `List users in course [Course ID]`,
          `Get completion report for user ${record.id} in course [Course ID]`,
        ],
        fields: [
          ...Object.keys(record),
          ...Object.keys(customFields).map((key) => `customfields.${key}`),
        ],
      },
    });
  };
}
