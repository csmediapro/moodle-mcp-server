import { z } from "zod";
import type { MCPServerPlugin } from "../contracts.js";
import { buildToolResponse, buildToolErrorResponse, type ToolInteractionsBlock } from "../../tools/response-types.js";
import { getDisplayFields, loadSchema } from "../../schema/user-fields.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface UserDirectoryCache {
  version: number;
  moodleUrl: string;
  generatedAt: string;
  rawUserCount: number;
  users: any[];
}

const inputSchema = z.object({
  filters: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe(
      "Structured filters keyed by normalized user field name. Supports standard Moodle fields and custom profile fields discovered for this site.",
    ),
  emptyFields: z
    .preprocess(
      (value) => {
        if (typeof value === "string") return [value];
        return value;
      },
      z.array(z.string().min(1)).optional().default([]),
    )
    .describe("Normalized user field names that must be empty, null, missing, or whitespace-only."),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum users to return"),
  offset: z.number().int().min(0).optional().default(0),
  refresh: z.boolean().optional().default(false).describe("INTERNAL ONLY. Force a full directory cache rebuild. Use ONLY if the user explicitly asks for a refresh or the data is known to be stale. Do not set this flag unless specifically required."),
  confirmed: z.boolean().optional().default(false).describe("INTERNAL ONLY. Set to true ONLY when responding to a server-side confirmation request. Do not set this flag by default - it will cause unnecessary cache rebuilds."),
});

const SUMMARY_SORT_VALUES = ["count_desc", "count_asc", "value_asc", "value_desc"] as const;
type SummarySort = (typeof SUMMARY_SORT_VALUES)[number];

const SUMMARY_SORT_ALIASES: Record<string, SummarySort> = {
  count: "count_desc",
  counts: "count_desc",
  countdesc: "count_desc",
  countdescending: "count_desc",
  count_descending: "count_desc",
  most: "count_desc",
  top: "count_desc",
  largest: "count_desc",
  countasc: "count_asc",
  countascending: "count_asc",
  count_ascending: "count_asc",
  least: "count_asc",
  fewest: "count_asc",
  smallest: "count_asc",
  value: "value_asc",
  values: "value_asc",
  name: "value_asc",
  names: "value_asc",
  alphabetical: "value_asc",
  alphabetic: "value_asc",
  alpha: "value_asc",
  valueasc: "value_asc",
  valueascending: "value_asc",
  value_ascending: "value_asc",
  valuedesc: "value_desc",
  valuedescending: "value_desc",
  value_descending: "value_desc",
  reversealphabetical: "value_desc",
  reverse_alpha: "value_desc",
};

function normalizeSummarySort(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (SUMMARY_SORT_VALUES.includes(trimmed as SummarySort)) return trimmed;

  const aliasKey = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  return SUMMARY_SORT_ALIASES[aliasKey] ?? SUMMARY_SORT_ALIASES[aliasKey.replace(/_/g, "")] ?? trimmed;
}

const emptyFieldsSchema = z.preprocess(
  (value) => {
    if (typeof value === "string") return [value];
    return value;
  },
  z.array(z.string().min(1)).optional().default([]),
);

const summarizeFieldInputSchema = z.object({
  field: z
    .string()
    .min(1)
    .describe("Normalized user field key to summarize, such as school, department, institution, role, or city"),
  filters: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Optional user filters to apply before summarizing the field"),
  emptyFields: emptyFieldsSchema.describe("Optional user fields that must be empty before summarizing the field"),
  includeEmpty: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include users where the field is empty, null, or missing"),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum grouped values to return"),
  offset: z.number().int().min(0).optional().default(0),
  sort: z.preprocess(
    normalizeSummarySort,
    z.enum(SUMMARY_SORT_VALUES).optional().default("count_desc"),
  ).describe(
    "Sort grouped field values. Canonical values: count_desc, count_asc, value_asc, value_desc. Common aliases like count, value, name, and alphabetical are accepted.",
  ),
});

const BASE_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "username", label: "Username" },
  { key: "fullname", label: "Full Name" },
  { key: "email", label: "Email" },
];

// Internal/control keys that should never be used as filters
const CONTROL_KEYS = new Set(["confirmed", "refresh", "limit", "offset", "emptyFields"]);

// Known aliases for common filter fields (model-friendly → normalized)
const FILTER_ALIASES: Record<string, string> = {
  School: "school",
  schoolName: "school",
  school_name: "school",
};

function getPresentationSchema() {
  const schema = loadSchema();
  return {
    schema,
    columns: schema ? getDisplayFields(schema) : BASE_COLUMNS,
  };
}

function projectRows(
  users: Array<Record<string, unknown>>,
  columns: Array<{ key: string; label: string }>,
): Array<Record<string, unknown>> {
  return users.map((user) => {
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      row[column.key] = user[column.key] ?? null;
    }
    return row;
  });
}

/**
 * Sanitize filters by stripping control keys and normalizing known aliases.
 * Returns a clean filters object suitable for in-memory filtering.
 */
function sanitizeFilters(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (CONTROL_KEYS.has(key)) continue;
    const normalizedKey = FILTER_ALIASES[key] ?? key;
    clean[normalizedKey] = value;
  }
  return clean;
}

function normalizeFieldKey(field: string): string {
  const trimmed = field.trim();
  return FILTER_ALIASES[trimmed] ?? trimmed;
}

function isEmptyUserFieldValue(value: unknown): boolean {
  return value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0);
}

function normalizeUserDirectoryQuery(rawFilters: Record<string, unknown>, rawEmptyFields: string[] = []) {
  const filters: Record<string, unknown> = {};
  const emptyFields = new Set<string>();

  for (const field of rawEmptyFields) {
    const normalizedField = normalizeFieldKey(field);
    if (normalizedField) emptyFields.add(normalizedField);
  }

  for (const [key, value] of Object.entries(sanitizeFilters(rawFilters))) {
    if (isEmptyUserFieldValue(value)) {
      emptyFields.add(key);
    } else {
      filters[key] = value;
    }
  }

  return {
    filters,
    emptyFields: Array.from(emptyFields),
  };
}

/**
 * Apply filters to an array of user records in memory.
 * String values are compared case-insensitively.
 */
function applyFilters(
  users: Array<Record<string, unknown>>,
  filters: Record<string, unknown>,
  emptyFields: string[] = [],
): Array<Record<string, unknown>> {
  const entries = Object.entries(filters);
  if (entries.length === 0 && emptyFields.length === 0) return users;

  return users.filter((user) => {
    for (const field of emptyFields) {
      if (!isEmptyUserFieldValue(user[field])) {
        return false;
      }
    }

    for (const [key, value] of entries) {
      const userVal = user[key];
      if (typeof value === "string" && typeof userVal === "string") {
        if (userVal.toLowerCase().trim() !== value.toLowerCase().trim()) {
          return false;
        }
      } else if (userVal !== value) {
        return false;
      }
    }
    return true;
  });
}

function cacheFilePath(): string {
  const cacheDir = process.env.MOODLE_CACHE_DIR || resolve(__dirname, "..", "..", "..", "data", "cache");
  return resolve(cacheDir, "user-directory.json");
}

async function loadDirectoryCache(moodleUrl: string): Promise<UserDirectoryCache | null> {
  try {
    const cacheData = await readFile(cacheFilePath(), "utf8");
    const cache = JSON.parse(cacheData) as UserDirectoryCache;
    if (
      cache.moodleUrl === moodleUrl &&
      Array.isArray(cache.users) &&
      cache.users.length > 0
    ) {
      return cache;
    }
  } catch {
    // Missing or unreadable cache is handled by the caller.
  }

  return null;
}

function buildPaginationInteractions(
  filters: Record<string, unknown>,
  emptyFields: string[],
  safeLimit: number,
  offset: number,
  hasMore: boolean,
): ToolInteractionsBlock | undefined {
  if (!hasMore) return undefined;
  return {
    mode: "tool_actions",
    prompt: "Show more users?",
    submitAs: "assistant_context",
    actions: [
      {
        type: "button",
        label: "Next page",
        tool: "list_users",
        args: {
          filters,
          emptyFields,
          limit: safeLimit,
          offset: offset + safeLimit,
          refresh: false,
          confirmed: true,
        },
        style: "primary",
      },
    ],
  };
}

function buildTableResponse(
  users: Array<Record<string, unknown>>,
  filters: Record<string, unknown>,
  emptyFields: string[],
  safeLimit: number,
  offset: number,
  cache: UserDirectoryCache,
  schema: any,
  columns: Array<{ key: string; label: string }>,
  extraWarnings?: string[],
) {
  const filteredUsers = applyFilters(users, filters, emptyFields);
  const totalFiltered = filteredUsers.length;
  const paginatedUsers = filteredUsers.slice(offset, offset + safeLimit);
  const hasMore = offset + paginatedUsers.length < totalFiltered;

  return buildToolResponse({
    meta: {
      tool: "list_users",
      title: "User Directory",
      entity: "user_directory",
      resultCount: paginatedUsers.length,
    },
    data: {
      kind: "table",
      title: "Users",
      columns,
      rows: projectRows(paginatedUsers, columns),
      pagination: {
        offset,
        limit: safeLimit,
        total: totalFiltered,
        hasMore,
      },
    },
    context: {
      summary: `Showing users ${totalFiltered === 0 ? 0 : offset + 1} to ${offset + paginatedUsers.length} of ${totalFiltered}`,
      warnings: extraWarnings ?? [],
      metrics: {
        totalUsers: totalFiltered,
        rawUserCount: cache.rawUserCount,
        displayedUsers: paginatedUsers.length,
        hasMore,
        offset,
        limit: safeLimit,
        filtersApplied: Object.keys(filters).length,
        emptyFieldsApplied: emptyFields.length,
        emptyFields: emptyFields.join(","),
        cacheGeneratedAt: cache.generatedAt,
        schemaUsed: !!schema,
        schemaVersion: schema?.schemaVersion ?? null,
      },
      suggestedQueries: [
        "Show the next page of users",
        "Filter users by department",
        "Filter users by institution",
        "Search for a specific user by name or email",
      ],
    },
    interactions: buildPaginationInteractions(filters, emptyFields, safeLimit, offset, hasMore),
  });
}

function normalizeGroupValue(value: unknown): string | null {
  if (isEmptyUserFieldValue(value)) return null;
  if (typeof value === "string") return value.trim();
  return String(value);
}

function fieldLabel(field: string): string {
  const schema = loadSchema();
  const schemaLabel = schema?.userFields?.[field]?.name;
  if (schemaLabel) return schemaLabel;

  return field
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function sortSummaryRows(
  rows: Array<{ value: string; userCount: number; percentOfUsers: number }>,
  sort: SummarySort,
) {
  return rows.sort((left, right) => {
    switch (sort) {
      case "count_asc":
        return left.userCount - right.userCount || left.value.localeCompare(right.value);
      case "value_asc":
        return left.value.localeCompare(right.value) || right.userCount - left.userCount;
      case "value_desc":
        return right.value.localeCompare(left.value) || right.userCount - left.userCount;
      case "count_desc":
      default:
        return right.userCount - left.userCount || left.value.localeCompare(right.value);
    }
  });
}

function buildFieldSummaryResponse(opts: {
  cache: UserDirectoryCache;
  field: string;
  filters: Record<string, unknown>;
  emptyFields: string[];
  includeEmpty: boolean;
  limit: number;
  offset: number;
  sort: SummarySort;
}) {
  const filteredUsers = applyFilters(cacheUsers(opts.cache), opts.filters, opts.emptyFields);
  const groups = new Map<string, { value: string; userCount: number }>();
  const emptyLabel = "(empty)";
  let emptyCount = 0;

  for (const user of filteredUsers) {
    const rawValue = normalizeGroupValue(user[opts.field]);
    if (!rawValue) {
      emptyCount += 1;
      if (!opts.includeEmpty) continue;
    }

    const value = rawValue ?? emptyLabel;
    const groupKey = value.toLowerCase();
    const existing = groups.get(groupKey);
    if (existing) {
      existing.userCount += 1;
    } else {
      groups.set(groupKey, { value, userCount: 1 });
    }
  }

  const rows = sortSummaryRows(
    Array.from(groups.values()).map((group) => ({
      value: group.value,
      userCount: group.userCount,
      percentOfUsers: filteredUsers.length > 0
        ? Math.round((group.userCount / filteredUsers.length) * 10000) / 100
        : 0,
    })),
    opts.sort,
  );
  const paginatedRows = rows.slice(opts.offset, opts.offset + opts.limit);
  const hasMore = opts.offset + paginatedRows.length < rows.length;
  const label = fieldLabel(opts.field);

  return buildToolResponse({
    meta: {
      tool: "summarize_user_directory_field",
      title: `${label} Summary`,
      entity: "user_directory_field_summary",
      resultCount: paginatedRows.length,
    },
    data: {
      kind: "table",
      title: `${label} by User Count`,
      columns: [
        { key: "value", label },
        { key: "userCount", label: "Users" },
        { key: "percentOfUsers", label: "% of Users" },
      ],
      rows: paginatedRows,
      pagination: {
        offset: opts.offset,
        limit: opts.limit,
        total: rows.length,
        hasMore,
      },
    },
    context: {
      summary: `Found ${rows.length} unique ${label.toLowerCase()} value${rows.length === 1 ? "" : "s"} across ${filteredUsers.length} cached user${filteredUsers.length === 1 ? "" : "s"}.`,
      warnings: opts.includeEmpty || emptyCount === 0
        ? []
        : [`${emptyCount} cached user${emptyCount === 1 ? "" : "s"} had no ${label.toLowerCase()} value and were excluded.`],
      metrics: {
        field: opts.field,
        uniqueValueCount: rows.length,
        usersSummarized: filteredUsers.length,
        emptyValueCount: emptyCount,
        includeEmpty: opts.includeEmpty,
        filtersApplied: Object.keys(opts.filters).length,
        emptyFieldsApplied: opts.emptyFields.length,
        emptyFields: opts.emptyFields.join(","),
        cacheGeneratedAt: opts.cache.generatedAt,
        rawUserCount: opts.cache.rawUserCount,
        hasMore,
        offset: opts.offset,
        limit: opts.limit,
      },
      suggestedQueries: [
        `Show users where ${opts.field} = [value]`,
        `Show ${label.toLowerCase()} values sorted alphabetically`,
        `Show empty ${label.toLowerCase()} users`,
      ],
    },
    interactions: hasMore
      ? {
          mode: "tool_actions",
          prompt: `Show more ${label.toLowerCase()} values?`,
          submitAs: "assistant_context",
          actions: [
            {
              type: "button",
              label: "Next page",
              tool: "summarize_user_directory_field",
              args: {
                field: opts.field,
                filters: opts.filters,
                emptyFields: opts.emptyFields,
                includeEmpty: opts.includeEmpty,
                limit: opts.limit,
                offset: opts.offset + opts.limit,
                sort: opts.sort,
              },
              style: "primary",
            },
          ],
        }
      : undefined,
  });
}

function cacheUsers(cache: UserDirectoryCache): Array<Record<string, unknown>> {
  return cache.users as Array<Record<string, unknown>>;
}

function buildMissingCacheResponse(tool: string, filters: Record<string, unknown>) {
  return buildToolResponse({
    meta: {
      tool,
      title: "User Directory Cache Required",
      entity: "user_directory",
      resultCount: 0,
    },
    data: {
      kind: "none",
      title: "Cache required",
    },
    context: {
      summary: "This query needs the local user directory cache before it can summarize cached users.",
      warnings: [
        "No cached user directory is available for this Moodle instance.",
        "Build the user directory cache first, then rerun the summary.",
      ],
      metrics: {
        cacheStatus: "missing",
        filtersApplied: Object.keys(filters).length,
      },
    },
    interactions: {
      mode: "tool_actions",
      prompt: "Build the user directory cache now?",
      submitAs: "assistant_context",
      actions: [
        {
          type: "button",
          label: "Build cache",
          tool: "list_users",
          args: {
            filters: {},
            limit: 100,
            offset: 0,
            confirmed: true,
          },
          style: "primary",
        },
      ],
    },
  });
}

export const plugin: MCPServerPlugin = {
  manifest: {
    id: "user-directory",
    name: "User Directory",
    version: "0.1.0",
    apiVersion: "1",
    description:
      "List and filter Moodle users with a local cache. " +
      "Provides structured directory queries and cached field summaries over normalized standard Moodle user fields and custom profile fields.",
    requiredCapabilities: ["core_user_get_users"],
    tools: ["list_users", "summarize_user_directory_field"],
  },

  agent: {
    promptRules: [
      "For site-wide user directory requests with field/value filters, call list_users directly. Example: \"list users with school = protrain\" -> list_users({ filters: { school: \"protrain\" }, limit: 100, offset: 0 }). Do not call get_user_field_schema first unless the user explicitly asks to inspect or configure the schema.",
      "For user-directory requests asking for users with no, missing, blank, empty, or null values in a field, call list_users with emptyFields. Example: \"list users with no school\" -> list_users({ emptyFields: [\"school\"], limit: 100, offset: 0 }).",
      "For cached user-directory grouping requests such as \"show unique schools\", \"show all unique schools from the user cache\", or \"count users by school\", call summarize_user_directory_field. Use the exact tool name summarize_user_directory_field, never summary_user_directory_field.",
      "For summarize_user_directory_field, use exact canonical sort values: count_desc for most users first, count_asc for fewest users first, value_asc for alphabetical A-Z, and value_desc for reverse alphabetical. Example: summarize_user_directory_field({ field: \"school\", limit: 100, offset: 0, sort: \"value_asc\" }).",
      "Site-wide directory tools such as list_users do not need a courseid.",
    ],
    intentRoutes: [
      {
        id: "user-directory-unique-schools",
        description: "Route unique school prompts to cached field summary.",
        match: "\\b(?:unique|uniques|distinct|all|every)\\s+(?:cached\\s+|user\\s+cache\\s+|cache\\s+)?schools?\\b|\\bschools?\\b.*?\\b(?:unique|uniques|distinct|from\\s+(?:the\\s+)?user\\s+cache|from\\s+(?:the\\s+)?cache)\\b",
        flags: "i",
        tool: "summarize_user_directory_field",
        args: { field: "school", limit: 100, offset: 0, sort: "value_asc" },
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
      {
        id: "user-directory-school-counts",
        description: "Route school count prompts to cached field summary.",
        match: "\\b(?:count|counts|number|numbers|how many)\\b.*?\\busers?\\b.*?\\b(?:by|per|for each)\\s+schools?\\b|\\bschools?\\b.*?\\b(?:count|counts|number|numbers|how many|assigned|users?\\s+(?:assigned\\s+)?to\\s+each)\\b",
        flags: "i",
        tool: "summarize_user_directory_field",
        args: { field: "school", limit: 100, offset: 0, sort: "count_desc" },
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
      {
        id: "user-directory-users-missing-school",
        description: "Route prompts for users missing a school value to list_users empty-field filtering.",
        match: "\\busers?\\b.*?\\b(?:with(?:out)?|where|whose|that\\s+(?:have|has))\\b.*?\\bschools?\\b.*?\\b(?:missing|empty|blank|null|none|no\\s+(?:value|entry)?)\\b|\\busers?\\b.*?\\b(?:missing|empty|blank|null|no)\\b.*?\\bschools?\\b|\\bschools?\\b.*?\\b(?:missing|empty|blank|null|no\\s+(?:value|entry)?)\\b.*?\\busers?\\b",
        flags: "i",
        tool: "list_users",
        args: { emptyFields: ["school"], limit: 100, offset: 0 },
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
      {
        id: "user-directory-users-with-field-value",
        description: "Route obvious filtered user-directory prompts to list_users.",
        match: "\\busers?\\b.*?\\b(?:with|where|whose)\\s+([A-Za-z][\\w -]{0,50}?)\\s*(?:=|:|is|equals?)\\s*[\"']?([^\"',.;?\\n]+)[\"']?",
        flags: "i",
        tool: "list_users",
        args: { limit: 100, offset: 0 },
        captures: [
          {
            kind: "filter",
            target: "filters",
            fieldGroup: 1,
            valueGroup: 2,
            fieldTransform: "filterKey",
            valueTransform: "filterValue",
          },
        ],
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
      {
        id: "user-directory-with-field-value-users",
        description: "Route field/value prompts that mention users later in the sentence.",
        match: "\\b(?:with|where|whose)\\s+([A-Za-z][\\w -]{0,50}?)\\s*(?:=|:|is|equals?)\\s*[\"']?([^\"',.;?\\n]+)[\"']?.*?\\busers?\\b",
        flags: "i",
        tool: "list_users",
        args: { limit: 100, offset: 0 },
        captures: [
          {
            kind: "filter",
            target: "filters",
            fieldGroup: 1,
            valueGroup: 2,
            fieldTransform: "filterKey",
            valueTransform: "filterValue",
          },
        ],
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
      {
        id: "user-directory-users-from-field-value",
        description: "Route prompts like 'users from school protrain'.",
        match: "\\busers?\\b.*?\\bfrom\\s+(?:the\\s+)?([A-Za-z][\\w -]{0,50}?)\\s+[\"']?([^\"',.;?\\n]+)[\"']?",
        flags: "i",
        tool: "list_users",
        args: { limit: 100, offset: 0 },
        captures: [
          {
            kind: "filter",
            target: "filters",
            fieldGroup: 1,
            valueGroup: 2,
            fieldTransform: "filterKey",
            valueTransform: "filterValue",
          },
        ],
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
    ],
    toolRewrites: [
      {
        id: "user-directory-schema-to-list-users",
        description: "If a provider tries schema lookup for an obvious filtered user list, execute list_users instead.",
        whenTool: "get_user_field_schema",
        match: "\\busers?\\b.*?\\b(?:with|where|whose)\\s+([A-Za-z][\\w -]{0,50}?)\\s*(?:=|:|is|equals?)\\s*[\"']?([^\"',.;?\\n]+)[\"']?",
        flags: "i",
        tool: "list_users",
        args: { limit: 100, offset: 0 },
        captures: [
          {
            kind: "filter",
            target: "filters",
            fieldGroup: 1,
            valueGroup: 2,
            fieldTransform: "filterKey",
            valueTransform: "filterValue",
          },
        ],
        exclude: ["\\b(schema|schemas|field schema|table columns?|display columns?|available fields?)\\b"],
      },
    ],
  },

  tools: [
    {
      name: "list_users",
      description:
        "List Moodle users using structured filters and a local cache. " +
        "Use this directly for site-wide user directory requests such as 'list users where school = protrain', field equals value filters, pagination, and reporting-friendly user lists. " +
        "Use emptyFields for requests like 'list users with no school', 'users missing school', or 'school is blank'. " +
        "Do not call get_user_field_schema before this tool for ordinary filtered user lists; pass the user's requested field/value in filters. " +
        "When a valid full-directory cache exists, filters are applied in memory against cached normalized users. " +
        "Filters may target normalized standard Moodle user fields or custom profile fields discovered for this site. " +
        "Returned table columns and rows honor the active user field schema display settings. " +
        "For fuzzy lookup of a specific person by name, email, username, or idnumber, use core search_users instead.",
      inputSchema,

      createHandler(ctx) {
        return async (args: unknown) => {
          const parsed = inputSchema.parse(args);
          const { limit = 100, offset = 0, refresh = false, confirmed = false } = parsed;
          const { filters, emptyFields } = normalizeUserDirectoryQuery(parsed.filters ?? {}, parsed.emptyFields ?? []);
          const moodleUrl = ctx.moodleClient.getBaseUrl();

          // Clamp limit within bounds
          const safeLimit = Math.min(Math.max(limit, 1), 1000);

          const cachePath = cacheFilePath();

          // Load cache if it exists
          let cache: UserDirectoryCache | null = null;
          try {
            const cacheData = await readFile(cachePath, "utf8");
            cache = JSON.parse(cacheData);
          } catch {
            cache = null;
          }

          const cacheValid =
            cache !== null &&
            cache.moodleUrl === moodleUrl &&
            Array.isArray(cache.users) &&
            cache.users.length > 0;

          // --- CACHE HIT: filter + paginate in memory ---
          if (cacheValid && cache && !refresh) {
            const { schema, columns } = getPresentationSchema();
            return buildTableResponse(cache.users, filters, emptyFields, safeLimit, offset, cache, schema, columns);
          }

          // --- CACHE MISS or REFRESH: ask for confirmation first ---
          if (!confirmed) {
            return buildToolResponse({
              meta: {
                tool: "list_users",
                title: "Confirm User Directory Cache Build",
                entity: "user_directory",
                resultCount: 0,
              },
              data: {
                kind: "none",
                title: "Confirmation required",
              },
              context: {
                summary:
                  "This query needs to fetch the Moodle user directory before filtering. The last benchmark took about 99 seconds for 14,641 users.",
                warnings: [
                  "This may take around a minute.",
                  "No users will be returned until you confirm.",
                ],
                metrics: {
                  cacheStatus: cache ? "mismatch" : "missing",
                  refreshRequested: refresh,
                  estimatedSeconds: 99,
                  filtersApplied: Object.keys(filters).length,
                  emptyFieldsApplied: emptyFields.length,
                  emptyFields: emptyFields.join(","),
                },
              },
              interactions: {
                mode: "tool_actions",
                prompt: "Build the user directory cache now?",
                submitAs: "assistant_context",
                actions: [
                  {
                    type: "button",
                    label: "Confirm",
                    tool: "list_users",
                    args: {
                      filters,
                      emptyFields,
                      limit: safeLimit,
                      offset,
                      refresh,
                      confirmed: true,
                    },
                    style: "primary",
                  },
                  {
                    type: "button",
                    label: "Cancel",
                    template: "Cancel user directory cache build",
                    style: "secondary",
                  },
                ],
              },
            });
          }

          // --- CONFIRMED: fetch all users, store full directory, filter in memory ---
          try {
            const response: any = await ctx.moodleClient.call({
              wsfunction: "core_user_get_users",
              params: {
                "criteria[0][key]": "email",
                "criteria[0][value]": "%%",
              },
            });

            const allUsers = response.users || [];
            const rawUserCount = allUsers.length;

            // Normalize: flatten custom fields into top-level keys
            const normalizedUsers = allUsers.map((user: any) => {
              const customFields: Record<string, any> = {};
              if (user.customfields) {
                for (const field of user.customfields) {
                  customFields[field.shortname] = field.value;
                }
              }
              return {
                id: user.id,
                username: user.username,
                email: user.email,
                fullname: user.fullname,
                firstname: user.firstname,
                lastname: user.lastname,
                suspended: user.suspended,
                confirmed: user.confirmed,
                auth: user.auth,
                department: user.department,
                institution: user.institution,
                ...customFields,
              };
            });

            // Store the FULL directory (unfiltered) in cache
            const newCache: UserDirectoryCache = {
              version: 1,
              moodleUrl,
              generatedAt: new Date().toISOString(),
              rawUserCount,
              users: normalizedUsers,
            };

            await mkdir(dirname(cachePath), { recursive: true });
            await writeFile(cachePath, JSON.stringify(newCache, null, 2));

            // Now filter + paginate from the full cache
            const { schema, columns } = getPresentationSchema();
            return buildTableResponse(normalizedUsers, filters, emptyFields, safeLimit, offset, newCache, schema, columns, [
              "User directory cache was just rebuilt and may take a moment to fully load.",
            ]);
          } catch (error: any) {
            return buildToolErrorResponse({
              error: {
                code: "FETCH_ERROR",
                message: error.message || "Unknown error occurred while fetching users",
                kind: "upstream",
                canRetry: true,
              },
              summary: "Failed to fetch user directory from Moodle",
              warnings: [error.message || "Unknown error occurred while fetching users"],
              meta: {
                tool: "list_users",
                title: "User Directory Error",
                entity: "user_directory",
                resultCount: 0,
              },
            });
          }
        };
      },
    },
    {
      name: "summarize_user_directory_field",
      description:
        "Summarize cached Moodle users by a normalized user field. " +
        "Use this for cached directory analytics such as unique schools, user counts by school, departments by user count, or distinct values for a custom profile field. " +
        "This tool reads the local full-directory cache and never fetches Moodle users itself. " +
        "For listing individual users matching a field value, use list_users.",
      inputSchema: summarizeFieldInputSchema,

      createHandler(ctx) {
        return async (args: unknown) => {
          const parsed = summarizeFieldInputSchema.parse(args);
          const field = normalizeFieldKey(parsed.field);
          const { filters, emptyFields } = normalizeUserDirectoryQuery(parsed.filters ?? {}, parsed.emptyFields ?? []);
          const limit = Math.min(Math.max(parsed.limit ?? 100, 1), 1000);
          const offset = parsed.offset ?? 0;
          const sort = parsed.sort ?? "count_desc";
          const cache = await loadDirectoryCache(ctx.moodleClient.getBaseUrl());

          if (!cache) {
            return buildMissingCacheResponse("summarize_user_directory_field", filters);
          }

          return buildFieldSummaryResponse({
            cache,
            field,
            filters,
            emptyFields,
            includeEmpty: parsed.includeEmpty ?? false,
            limit,
            offset,
            sort,
          });
        };
      },
    },
  ],
};
