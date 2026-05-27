import { MoodleClient } from "../moodle/client.js";
import { hasCapability, MoodleCapabilities } from "../moodle/capabilities.js";
import { logger } from "../logging/index.js";
import { z } from "zod";
import {
  buildToolErrorResponse,
  buildToolResponse,
} from "./response-types.js";

export const name = "get_user";

export const description =
  "Fetch one Moodle user by exact ID, email, or username. " +
  "Provide exactly one of id, email, or username. " +
  "Returns a single structured user record.";

export const inputSchema = z.object({
  id: z.number().int().positive().optional().describe("Exact Moodle user ID"),
  email: z.string().trim().email().optional().describe("Exact email address"),
  username: z.string().trim().min(1).optional().describe("Exact Moodle username"),
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
  suspended?: boolean;
  confirmed?: boolean;
  auth?: string;
};

function normalizeUser(user: MoodleUser) {
  return {
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
    firstaccess: user.firstaccess ? new Date(user.firstaccess * 1000).toISOString() : null,
    lastaccess: user.lastaccess ? new Date(user.lastaccess * 1000).toISOString() : null,
  };
}

export function createHandler(client: MoodleClient, caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      id?: number;
      email?: string;
      username?: string;
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

    const record = normalizeUser(users[0]);

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
        title: `User Details — ${record.fullname}`,
        record,
      },
      context: {
        summary:
          record.lastaccess
            ? `${record.fullname} was found and has logged into Moodle before.`
            : `${record.fullname} was found, but there is no recorded Moodle access timestamp yet.`,
        metrics: {
          id: record.id,
          suspended: record.suspended,
          confirmed: record.confirmed,
        },
        highlights: [
          `Lookup field: ${field}`,
        ],
        suggestedQueries: [
          `List courses for user ${record.id}`,
          `List users in course [Course ID]`,
        ],
        fields: Object.keys(record),
      },
    });
  };
}
