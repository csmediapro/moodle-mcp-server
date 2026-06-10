/**
 * User Field Schema tools — discover, read, and update the user field registry.
 *
 * Three tools for the operator/admin dashboard:
 *   - get_user_field_schema    — read the current schema
 *   - refresh_user_field_schema — discover fields from Moodle and create/update schema
 *   - update_user_field_schema  — toggle display/filterable on specific fields
 *   - reorder_user_field_schema — move displayed user table columns
 */

import { z } from "zod";
import { MoodleClient } from "../moodle/client.js";
import {
  type UserFieldSchema,
  loadSchema,
  saveSchema,
  discoverFields,
  mergeSchema,
  diffSchemas,
  applyUpdates,
  getDisplayFields,
  getFieldSortOrderValue,
  normalizeDisplayOrder,
  reorderDisplayField,
} from "../schema/user-fields.js";
import { buildToolErrorResponse, buildToolResponse } from "./response-types.js";
import { logger } from "../logging/index.js";

function buildFieldRows(schema: UserFieldSchema) {
  return Object.entries(schema.userFields)
    .map(([key, def]) => ({
      key,
      name: def.name,
      type: def.type,
      source: def.source,
      display: def.display,
      filterable: def.filterable,
      displayOrder: def.displayOrder ?? null,
    }))
    .sort((a, b) => {
      if (a.display !== b.display) {
        return a.display ? -1 : 1;
      }

      if (a.display && b.display) {
        const orderDiff = getFieldSortOrderValue(a.key, schema) - getFieldSortOrderValue(b.key, schema);
        if (orderDiff !== 0) return orderDiff;
      }

      return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
    });
}

const fieldSchemaColumns = [
  { key: "displayOrder", label: "Order" },
  { key: "key", label: "Field Key" },
  { key: "name", label: "Field Name" },
  { key: "type", label: "Type" },
  { key: "source", label: "Source" },
  { key: "display", label: "Display" },
  { key: "filterable", label: "Filterable" },
];

function buildUserFieldSchemaTable(schema: UserFieldSchema) {
  return {
    columns: fieldSchemaColumns,
    rows: buildFieldRows(schema),
  };
}

// ─── get_user_field_schema ────────────────────────────────────────────────────

export const getSchemaName = "get_user_field_schema";

export const getSchemaDescription =
  "Admin/config tool: return the current user field schema for this Moodle instance. " +
  "Shows every known user field (standard + custom), its type, source, " +
  "and whether it is currently set to display in tables or accept filters. " +
  "Use this when the user explicitly asks to inspect, configure, show, refresh, or troubleshoot the user field schema or table columns. " +
  "Do not use this before ordinary requests to list or filter users; call list_users directly with filters instead. " +
  "If no schema exists yet, the response will tell you to run refresh_user_field_schema. " +
  "No parameters required.";

export const getSchemaInput = z.object({});

export function createGetSchemaHandler() {
  return async () => {
    const schema = loadSchema();

    if (!schema) {
      return buildToolErrorResponse({
        error: {
          code: "no_user_field_schema",
          message:
            "This Moodle instance hasn't been scanned for user fields yet. " +
            "Use refresh_user_field_schema to discover them.",
          kind: "not_found",
          canRetry: true,
          actionRequired: "Run refresh_user_field_schema",
        },
        summary:
          "No user field schema exists for this Moodle instance yet. " +
          "The schema controls which fields appear in user tables and which fields schema-aware tools may use as filters.",
        meta: {
          tool: getSchemaName,
          title: "User Field Schema",
          entity: "schema",
          resultCount: 0,
        },
        suggestedQueries: [
          "Refresh the user field schema",
        ],
        interactions: {
          mode: "tool_actions",
          prompt: "Discover the available standard and custom Moodle user fields.",
          submitAs: "user_message",
          actions: [
            {
              type: "button",
              label: "Discover Fields",
              template: "Refresh the user field schema",
              style: "primary",
            },
          ],
        },
      });
    }

    const displayFields = getDisplayFields(schema);
    const table = buildUserFieldSchemaTable(schema);
    const fieldList = Object.entries(schema.userFields).map(([key, def]) => ({
      key,
      name: def.name,
      type: def.type,
      source: def.source,
      display: def.display,
      filterable: def.filterable,
    }));

    // Summary counts
    const standardCount = fieldList.filter((f) => f.source === "standard").length;
    const customCount = fieldList.filter((f) => f.source === "custom").length;
    const displayCount = fieldList.filter((f) => f.display).length;
    const filterableCount = fieldList.filter((f) => f.filterable).length;

    return buildToolResponse({
      meta: {
        tool: getSchemaName,
        title: "User Field Schema",
        entity: "schema",
        resultCount: fieldList.length,
      },
      data: {
        kind: "table",
        title: "User Field Schema",
        columns: table.columns,
        rows: table.rows,
      },
      context: {
        summary:
          `Schema v${schema.schemaVersion} — ${fieldList.length} total fields ` +
          `(${standardCount} standard, ${customCount} custom). ` +
          `${displayCount} displayed in tables, ${filterableCount} available to schema-aware tools as filters. ` +
          `Use update_user_field_schema to toggle display or filterable on any field.`,
        highlights: [
          `Generated: ${schema.generatedAt}`,
          `Moodle: ${schema.siteUrl} (${schema.moodleVersion})`,
          `Active table columns (${displayCount}): ${displayFields.map((f) => f.label).join(", ") || "(none)"}`,
        ],
        metrics: {
          schemaVersion: schema.schemaVersion,
          totalFields: fieldList.length,
          standardFields: standardCount,
          customFields: customCount,
          displayedInTables: displayCount,
          availableAsFilters: filterableCount,
        },
        suggestedQueries: [
          "Refresh the user field schema",
          "Hide [field name] from user tables",
          "Show fields available to user directory tools",
        ],
        fields: fieldList.map((f) => f.key),
      },
    });
  };
}

// ─── refresh_user_field_schema ────────────────────────────────────────────────

export const refreshSchemaName = "refresh_user_field_schema";

export const refreshSchemaDescription =
  "Discover all available user fields from the connected Moodle instance and " +
  "create or update the user field schema. " +
  "Samples standard fields from the current user and custom profile fields from " +
  "enrolled users across courses. " +
  "Use this when: connecting to a new Moodle instance for the first time, " +
  "or after a Moodle admin adds/removes custom profile fields, " +
  "or when the operator asks to 'refresh the user fields'. " +
  "Optional 'force' parameter (default false): when true, re-merges all fields " +
  "from scratch (operator overrides on still-existing fields are preserved). " +
  "When false, compares discovered fields against the stored schema and only " +
  "updates if there are differences to report.";

export const refreshSchemaInput = z.object({
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force a full re-merge from scratch even if nothing changed"),
});

export function createRefreshSchemaHandler(client: MoodleClient) {
  return async (args: unknown) => {
    const parsed = refreshSchemaInput.parse(args) as { force: boolean };
    const existing = loadSchema();

    // Discover fields from Moodle
    let discovered;
    try {
      discovered = await discoverFields(client);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("Field discovery failed", {
        event: "schema_discovery_failed",
        error: msg,
      });
      return buildToolErrorResponse({
        error: {
          code: "discovery_failed",
          message: `Field discovery failed: ${msg}`,
          kind: "upstream",
          canRetry: true,
          actionRequired: "Check the Moodle connection and token permissions, then retry.",
        },
        summary: `Could not discover user fields from Moodle: ${msg}`,
        meta: {
          tool: refreshSchemaName,
          title: "Refresh User Field Schema",
          entity: "schema",
          resultCount: 0,
        },
        suggestedQueries: [
          "Check the LMS connection with get_site_info",
        ],
      });
    }

    // Get site URL + version for the schema
    const siteInfo = await client.call<{
      sitename?: string;
      siteurl?: string;
      version?: string;
      release?: string;
    }>({ wsfunction: "core_webservice_get_site_info" });

    const siteUrl = siteInfo.siteurl ?? existing?.siteUrl ?? "unknown";
    const moodleVersion = siteInfo.release ?? siteInfo.version ?? existing?.moodleVersion ?? "unknown";

    if (!existing) {
      // First time: create schema from scratch
      const schema = mergeSchema(discovered, siteUrl, moodleVersion);
      saveSchema(schema);

      const customCount = Object.values(schema.userFields).filter((f) => f.source === "custom").length;
      const displayFields = getDisplayFields(schema);
      const table = buildUserFieldSchemaTable(schema);

      return buildToolResponse({
        meta: {
          tool: refreshSchemaName,
          title: "User Field Schema Created",
          entity: "schema",
          resultCount: table.rows.length,
        },
        data: {
          kind: "table",
          title: "Created User Field Schema",
          columns: table.columns,
          rows: table.rows,
        },
        context: {
          summary:
            `Created user field schema v${schema.schemaVersion} with ` +
            `${table.rows.length} fields (${customCount} custom). ` +
            `${displayFields.length} fields will appear in user search tables.`,
          highlights: [
            `Moodle: ${schema.siteUrl} (${schema.moodleVersion})`,
            `Custom fields: ${Object.keys(schema.userFields).filter((k) => schema.userFields[k].source === "custom").map((k) => schema.userFields[k].name).join(", ") || "(none)"}`,
            `Table columns: ${displayFields.map((f) => f.label).join(", ")}`,
          ],
          metrics: {
            schemaVersion: schema.schemaVersion,
            totalFields: table.rows.length,
            customFields: customCount,
            displayFields: displayFields.length,
          },
          suggestedQueries: [
            "Show the current user field schema",
            "Hide [field name] from user tables",
            "Search users by [criteria]",
          ],
        },
      });
    }

    // Existing schema: compare
    if (!parsed.force) {
      const candidateSchema = mergeSchema(discovered, siteUrl, moodleVersion, existing, existing.schemaVersion);
      const diff = diffSchemas(existing, candidateSchema);

      const hasAnyChange =
        diff.added.length > 0 ||
        diff.removed.length > 0 ||
        diff.typeChanged.length > 0;

      if (!hasAnyChange) {
        const displayFields = getDisplayFields(existing);
        const table = buildUserFieldSchemaTable(existing);
        const customCount = Object.values(existing.userFields).filter((f) => f.source === "custom").length;

        return buildToolResponse({
          meta: {
            tool: refreshSchemaName,
            title: "User Field Schema Unchanged",
            entity: "schema",
            resultCount: table.rows.length,
          },
          data: {
            kind: "table",
            title: "Current User Field Schema",
            columns: table.columns,
            rows: table.rows,
          },
          context: {
            summary:
              "The stored user field schema already matches the fields discovered from Moodle. " +
              `${table.rows.length} fields are shown below, including ${customCount} custom fields.`,
            highlights: [
              `Schema v${existing.schemaVersion}`,
              `Table columns: ${displayFields.map((f) => f.label).join(", ") || "(none)"}`,
              "To force a refresh anyway, call refresh_user_field_schema with force: true",
            ],
            metrics: {
              schemaVersion: existing.schemaVersion,
              totalFields: table.rows.length,
              customFields: customCount,
              displayFields: displayFields.length,
            },
            suggestedQueries: [
              "Show the current user field schema",
              "Update user field schema [field] display [true/false]",
            ],
          },
        });
      }
    }

    // Has changes or force: save the new schema
    const schemaVersion = existing.schemaVersion + 1;
    const newSchema = mergeSchema(discovered, siteUrl, moodleVersion, existing, schemaVersion);
    const diff = diffSchemas(existing, newSchema);

    saveSchema(newSchema);

    const displayFields = getDisplayFields(newSchema);
    const table = buildUserFieldSchemaTable(newSchema);
    const customCount = Object.values(newSchema.userFields).filter((f) => f.source === "custom").length;

    return buildToolResponse({
      meta: {
        tool: refreshSchemaName,
        title: "User Field Schema Updated",
        entity: "schema",
        resultCount: table.rows.length,
      },
      data: {
        kind: "table",
        title: "Updated User Field Schema",
        columns: table.columns,
        rows: table.rows,
      },
      context: {
        summary:
          `Updated schema to v${newSchema.schemaVersion}. ` +
          [
            diff.added.length > 0 ? `${diff.added.length} field(s) added` : null,
            diff.removed.length > 0 ? `${diff.removed.length} field(s) removed` : null,
            diff.typeChanged.length > 0 ? `${diff.typeChanged.length} type change(s)` : null,
          ]
            .filter(Boolean)
            .join(", ") +
          ".",
        highlights: [
          ...diff.added.map((k) => `Added: ${k}`),
          ...diff.removed.map((k) => `Removed: ${k}`),
          ...diff.typeChanged.map((c) => `Type changed: ${c.key} (${c.from} → ${c.to})`),
        ],
        metrics: {
          schemaVersion: newSchema.schemaVersion,
          totalFields: table.rows.length,
          customFields: customCount,
          displayFields: displayFields.length,
          fieldsAdded: diff.added.length,
          fieldsRemoved: diff.removed.length,
          typesChanged: diff.typeChanged.length,
        },
        suggestedQueries: [
          "Show the current user field schema",
          "Update user field schema [field] display [true/false]",
        ],
      },
    });
  };
}

// ─── update_user_field_schema ─────────────────────────────────────────────────

export const updateSchemaName = "update_user_field_schema";

export const updateSchemaDescription =
  "Update display and filter settings for specific user fields. " +
  "Only include fields you want to change — omitted fields keep their current settings. " +
  "Use this when the operator wants to: " +
  "show or hide a field in user search result tables (display), " +
  "or enable/disable a field for schema-aware directory filtering (filterable). " +
  "This is an admin/configuration tool, not a prerequisite for ordinary filtered user-list requests. " +
  "FIELD KEYS: Use the exact short field keys from get_user_field_schema " +
  "(common keys: id, fullname, email, username, department, institution, city, country, " +
  "firstaccess, lastaccess, suspended, confirmed, idnumber). " +
  "For a single field, prefer the shortcut fields: field='username', display=false. " +
  "EXAMPLES: " +
  "'hide username from user tables' → " +
  '{"field":"username","display":false}. ' +
  "'hide firstaccess and department from user tables' → " +
  '{"updates":{"firstaccess":{"display":false},"department":{"display":false}}}. ' +
  "'make city visible in tables and available to schema-aware filters' → " +
  '{"updates":{"city":{"display":true,"filterable":true}}}. ' +
  "'show a discovered custom field in tables' → " +
  '{"updates":{"customFieldKey":{"display":true}}}."';

const fieldUpdateSchema = z.object({
  display: z
    .boolean()
    .optional()
    .describe("Show this field as a column in user search result tables"),
  filterable: z
    .boolean()
    .optional()
    .describe("Allow schema-aware directory tools to use this field as a filter"),
});

export const updateSchemaInput = z.object({
  updates: z
    .record(
      z.string().describe("Field key exactly as shown in get_user_field_schema"),
      fieldUpdateSchema,
    )
    .optional()
    .describe(
      "Map of field keys to new settings. Only include fields you want to change.",
    ),
  field: z
    .string()
    .optional()
    .describe("Shortcut for updating one field key, e.g. username"),
  display: z
    .boolean()
    .optional()
    .describe("Shortcut value for whether the single field appears in user tables"),
  filterable: z
    .boolean()
    .optional()
    .describe("Shortcut value for whether schema-aware directory tools can use the single field as a filter"),
}).refine(
  (value) => value.updates !== undefined || value.field !== undefined,
  {
    message: "Provide either updates or field",
    path: ["updates"],
  },
);

function normalizeUpdateArgs(args: unknown): Record<string, { display?: boolean; filterable?: boolean }> {
  if (typeof args === "object" && args !== null) {
    const raw = args as {
      updates?: unknown;
      field?: unknown;
      display?: unknown;
      filterable?: unknown;
    };

    // Backward-compatible guard for accidental {"updates":"username"} calls.
    if (typeof raw.updates === "string") {
      return { [raw.updates]: { display: false } };
    }
  }

  const parsed = updateSchemaInput.parse(args) as {
    updates?: Record<string, { display?: boolean; filterable?: boolean }>;
    field?: string;
    display?: boolean;
    filterable?: boolean;
  };

  if (parsed.updates) {
    return parsed.updates;
  }

  const update: { display?: boolean; filterable?: boolean } = {};
  if (parsed.display !== undefined) update.display = parsed.display;
  if (parsed.filterable !== undefined) update.filterable = parsed.filterable;
  if (Object.keys(update).length === 0) update.display = false;

  return { [parsed.field!]: update };
}

export function createUpdateSchemaHandler() {
  return async (args: unknown) => {
    const updates = normalizeUpdateArgs(args);

    const schema = loadSchema();
    if (!schema) {
      return buildToolErrorResponse({
        error: {
          code: "no_user_field_schema",
          message:
            "No user field schema exists yet. Run refresh_user_field_schema first.",
          kind: "not_found",
          canRetry: true,
          actionRequired: "Run refresh_user_field_schema",
        },
        summary:
          "I couldn't update the user field schema because none exists yet. " +
          "Ask me to refresh the user field schema first.",
        meta: {
          tool: updateSchemaName,
          title: "Update User Field Schema",
          entity: "schema",
          resultCount: 0,
        },
        suggestedQueries: [
          "Refresh the user field schema",
        ],
      });
    }

    let result;
    try {
      result = applyUpdates(schema, updates);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return buildToolErrorResponse({
        error: {
          code: "invalid_field_keys",
          message: msg,
          kind: "validation",
          canRetry: true,
          actionRequired: "Check get_user_field_schema for valid field keys and retry.",
        },
        summary: `Could not update the schema: ${msg}`,
        meta: {
          tool: updateSchemaName,
          title: "Update User Field Schema",
          entity: "schema",
          resultCount: 0,
        },
        suggestedQueries: [
          "Show the current user field schema",
        ],
      });
    }

    if (result.changed.length === 0) {
      return buildToolResponse({
        meta: {
          tool: updateSchemaName,
          title: "User Field Schema Unchanged",
          entity: "schema",
          resultCount: 0,
        },
        data: {
          kind: "record",
          title: "No Changes Applied",
          record: {
            message:
              "All requested settings already match the current schema. No changes needed.",
            schemaVersion: schema.schemaVersion,
          },
        },
        context: {
          summary: "No field settings were changed — all requested values already matched.",
          suggestedQueries: [
            "Show the current user field schema",
          ],
        },
      });
    }

    normalizeDisplayOrder(result.schema);
    saveSchema(result.schema);
    const displayFields = getDisplayFields(result.schema);

    return buildToolResponse({
      meta: {
        tool: updateSchemaName,
        title: "User Field Schema Updated",
        entity: "schema",
        resultCount: result.changed.length,
      },
      data: {
        kind: "record",
        title: "Field Settings Updated",
        record: {
          schemaVersion: result.schema.schemaVersion,
          changedFields: result.changed,
          currentTableColumns: displayFields.map((f) => f.label),
        },
      },
      context: {
        summary:
          `Updated ${result.changed.length} field setting(s): ${result.changed.join(", ")}. ` +
          `Table columns are now: ${displayFields.map((f) => f.label).join(", ") || "(none)"}.`,
        highlights: result.changed.map((key) => {
          const def = result.schema.userFields[key];
          return `${key}: display=${def.display}, filterable=${def.filterable}`;
        }),
        metrics: {
          fieldsChanged: result.changed.length,
          displayFieldCount: displayFields.length,
        },
        suggestedQueries: [
          "Show the current user field schema",
          "Search users by [criteria]",
        ],
      },
    });
  };
}

// ─── reorder_user_field_schema ────────────────────────────────────────────────

export const reorderSchemaName = "reorder_user_field_schema";

export const reorderSchemaDescription =
  "Reorder displayed user table columns in the user field schema. " +
  "Use this when the operator asks to move a column left, right, first, last, before another field, or after another field. " +
  "The field and target values must be exact field keys from get_user_field_schema, such as id, fullname, email, lastaccess, department, institution, or suspended. " +
  "Natural language examples: " +
  "'move last access all the way to the right' → {\"field\":\"lastaccess\",\"position\":\"end\"}. " +
  "'move department after email' → {\"field\":\"department\",\"after\":\"email\"}. " +
  "'put suspended before lastaccess' → {\"field\":\"suspended\",\"before\":\"lastaccess\"}. " +
  "'move full name to the far left' → {\"field\":\"fullname\",\"position\":\"start\"}.";

export const reorderSchemaInput = z.object({
  field: z
    .string()
    .describe("Field key to move, e.g. lastaccess, department, email, or suspended"),
  position: z
    .enum(["start", "end"])
    .optional()
    .describe("Move the field to the far left/start or far right/end of displayed columns"),
  before: z
    .string()
    .optional()
    .describe("Move the field immediately before this displayed field key"),
  after: z
    .string()
    .optional()
    .describe("Move the field immediately after this displayed field key"),
}).refine(
  (value) => [value.position, value.before, value.after].filter((v) => v !== undefined).length === 1,
  {
    message: "Provide exactly one of position, before, or after",
    path: ["position"],
  },
);

export function createReorderSchemaHandler() {
  return async (args: unknown) => {
    const parsed = reorderSchemaInput.parse(args) as {
      field: string;
      position?: "start" | "end";
      before?: string;
      after?: string;
    };

    const schema = loadSchema();
    if (!schema) {
      return buildToolErrorResponse({
        error: {
          code: "no_user_field_schema",
          message:
            "No user field schema exists yet. Run refresh_user_field_schema first.",
          kind: "not_found",
          canRetry: true,
          actionRequired: "Run refresh_user_field_schema",
        },
        summary:
          "I couldn't reorder the user field schema because none exists yet. " +
          "Ask me to refresh the user field schema first.",
        meta: {
          tool: reorderSchemaName,
          title: "Reorder User Field Schema",
          entity: "schema",
          resultCount: 0,
        },
        suggestedQueries: [
          "Refresh the user field schema",
        ],
      });
    }

    try {
      normalizeDisplayOrder(schema);
      const result = reorderDisplayField(schema, parsed);
      saveSchema(result.schema);
      const table = buildUserFieldSchemaTable(result.schema);

      return buildToolResponse({
        meta: {
          tool: reorderSchemaName,
          title: "User Field Columns Reordered",
          entity: "schema",
          resultCount: table.rows.length,
        },
        data: {
          kind: "table",
          title: "User Field Schema",
          columns: table.columns,
          rows: table.rows,
        },
        context: {
          summary:
            `Moved ${parsed.field}. Current table columns: ` +
            `${result.order.map((field) => field.label).join(", ") || "(none)"}.`,
          metrics: {
            displayFieldCount: result.order.length,
            fieldsReindexed: result.changed.length,
          },
          suggestedQueries: [
            "Search users by [criteria]",
            "Show the current user field schema",
          ],
          fields: result.order.map((field) => field.key),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return buildToolErrorResponse({
        error: {
          code: "invalid_reorder_request",
          message: msg,
          kind: "validation",
          canRetry: true,
          actionRequired: "Check get_user_field_schema for valid visible field keys and retry.",
        },
        summary: `Could not reorder the schema: ${msg}`,
        meta: {
          tool: reorderSchemaName,
          title: "Reorder User Field Schema",
          entity: "schema",
          resultCount: 0,
        },
        suggestedQueries: [
          "Show the current user field schema",
        ],
      });
    }
  };
}
