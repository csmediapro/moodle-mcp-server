/**
 * User Field Schema — discovery, persistence, and lifecycle.
 *
 * ## Architecture
 *
 * Three sources merge into one persisted schema:
 *   1. Discovery (Moodle sampling) — "what fields exist?"
 *   2. Defaults file — "how should they behave by default?"
 *   3. Operator overrides — "what did the operator change?"
 *
 * The persisted JSON is the single source of truth at runtime.
 * Tools read it; operators refresh/update it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MoodleClient } from "../moodle/client.js";
import { getDefaults, type FieldDefaults } from "./user-field-defaults.js";
import { logger } from "../logging/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserFieldDef extends FieldDefaults {
  /** Human-readable display name (e.g. "Last Access") */
  name: string;
  /** Value type: "string" | "number" | "boolean" | "timestamp" | "text" | "menu" | "checkbox" */
  type: string;
  /** Where this field came from: "standard" (Moodle core) or "custom" (profile field) */
  source: "standard" | "custom";
}

export interface UserFieldSchema {
  schemaVersion: number;
  generatedAt: string;
  siteUrl: string;
  moodleVersion: string;
  userFields: Record<string, UserFieldDef>;
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  typeChanged: Array<{ key: string; from: string; to: string }>;
  unchanged: string[];
}

export interface SchemaUpdateResult {
  schema: UserFieldSchema;
  changed: string[];
}

export interface DisplayFieldDef {
  key: string;
  label: string;
  source: "standard" | "custom";
  type: string;
  displayOrder?: number;
}

export interface SchemaReorderResult {
  schema: UserFieldSchema;
  changed: string[];
  order: DisplayFieldDef[];
}

interface DiscoveredStandardField {
  key: string;
  type: string;
}

interface DiscoveredCustomField {
  shortname: string;
  name: string;
  type: string;
}

interface DiscoveredFields {
  standard: Record<string, string>;    // key → type
  custom: Record<string, { name: string; type: string }>; // shortname → { name, type }
}

// ─── File path ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function schemaFilePath(): string {
  // Resolve from source tree during dev, dist during production
  // Always store in packages/server/data/
  const serverRoot = resolve(__dirname, "..", "..");
  return resolve(serverRoot, "data", "user-field-schema.json");
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function loadSchema(): UserFieldSchema | null {
  const path = schemaFilePath();
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    // Basic validation
    if (!parsed.schemaVersion || !parsed.userFields) return null;
    return parsed as UserFieldSchema;
  } catch (e) {
    logger.warn("Failed to load user field schema", {
      event: "schema_load_failed",
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export function saveSchema(schema: UserFieldSchema): void {
  const path = schemaFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(schema, null, 2), "utf-8");
  logger.info("User field schema saved", {
    event: "schema_saved",
    path,
    version: schema.schemaVersion,
    fieldCount: Object.keys(schema.userFields).length,
  });
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Sample Moodle users to discover all user fields (standard + custom).
 *
 * Standard fields: inferred from a single user lookup + typeof on values.
 * Custom fields: sampled from enrolled users across courses.
 *
 * Bounded to avoid excessive API calls. Stops early when custom field
 * discovery stabilizes.
 */
export async function discoverFields(client: MoodleClient): Promise<DiscoveredFields> {
  logger.info("Starting user field discovery");

  // 1. Get site info for current user ID
  const siteInfo = await client.call<{
    sitename?: string;
    userid?: number;
    version?: string;
    release?: string;
  }>({ wsfunction: "core_webservice_get_site_info" });

  const currentUserId = siteInfo.userid;
  if (!currentUserId) {
    throw new Error("Could not determine current user ID from site info");
  }

  // 2. Get current user to discover standard fields
  const [currentUser] = await client.call<Array<Record<string, unknown>>>({
    wsfunction: "core_user_get_users_by_field",
    params: { field: "id", "values[0]": String(currentUserId) },
  });

  const standard: Record<string, string> = {};
  const custom: Record<string, { name: string; type: string }> = {};

  if (currentUser) {
    // Extract standard fields (skip known non-field keys and customfields)
    for (const [key, value] of Object.entries(currentUser)) {
      if (key === "customfields" || key === "preferences") continue;
      standard[key] = inferType(key, value);
    }

    // Extract custom fields from current user
    const customFields = currentUser.customfields as Array<{
      type: string;
      value: string;
      name: string;
      shortname: string;
    }> | undefined;
    if (customFields) {
      for (const cf of customFields) {
        custom[cf.shortname] = { name: cf.name, type: cf.type };
      }
    }
  }

  logger.debug("Standard fields discovered from current user", {
    event: "schema_discovery_standard",
    fieldCount: Object.keys(standard).length,
  });

  // 3. Sample enrolled users across courses to discover custom fields
  // that may not appear on the current user's profile.
  try {
    const courses = await client.call<Array<{ id: number }>>({
      wsfunction: "core_course_get_courses_by_field",
    });

    const maxCourses = 30;
    const usersPerCourse = 5;

    for (let i = 0; i < Math.min(courses.length, maxCourses); i++) {
      try {
        const users = await client.call<Array<Record<string, unknown>>>({
          wsfunction: "core_enrol_get_enrolled_users",
          params: {
            courseid: courses[i].id,
            "options[0][name]": "limitnumber",
            "options[0][value]": String(usersPerCourse),
          },
        });

        for (const user of users) {
          const customFields = user.customfields as Array<{
            type: string;
            value: string;
            name: string;
            shortname: string;
          }> | undefined;
          if (customFields) {
            for (const cf of customFields) {
              if (!custom[cf.shortname]) {
                custom[cf.shortname] = { name: cf.name, type: cf.type };
              }
            }
          }
        }
      } catch {
        // Skip courses where enrollment API fails (e.g. deleted courses)
      }
    }
  } catch (e) {
    logger.warn("Course sampling during field discovery failed — continuing with partial results", {
      event: "schema_discovery_course_sample_failed",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 4. Sample via lastname search to catch custom fields that only appear
  // on student accounts (e.g. "school"). Moodle core_user_get_users does
  // exact-match only, so we query common last names to cover the population.
  try {
    const sampleLastnames = [
      "Smith", "Johnson", "Williams", "Brown", "Jones",
      "Miller", "Davis", "Wilson", "Moore", "Taylor",
      "Anderson", "Jackson", "White", "Harris", "Martin",
    ];
    const usersPerName = 10;
    let prevCount = Object.keys(custom).length;
    let stableCount = 0;

    for (const lastname of sampleLastnames) {
      try {
        const searchedUsers = await client.call<{ users?: Array<Record<string, unknown>> }>({
          wsfunction: "core_user_get_users",
          params: {
            "criteria[0][key]": "lastname",
            "criteria[0][value]": lastname,
          },
        });

        const sample = (searchedUsers.users ?? []).slice(0, usersPerName);
        for (const user of sample) {
          const cfs = user.customfields as Array<{
            type: string;
            value: string;
            name: string;
            shortname: string;
          }> | undefined;
          if (cfs) {
            for (const cf of cfs) {
              if (!custom[cf.shortname]) {
                custom[cf.shortname] = { name: cf.name, type: cf.type };
              }
            }
          }
        }

        const newCount = Object.keys(custom).length;
        if (newCount > prevCount) {
          prevCount = newCount;
          stableCount = 0;
        } else {
          stableCount++;
          if (stableCount >= 3) {
            logger.debug("Custom field discovery stabilized via lastname search", {
              event: "schema_discovery_stabilized",
              lettersSampled: sampleLastnames.indexOf(lastname) + 1,
              customFieldCount: newCount,
            });
            break;
          }
        }
      } catch {
        // Individual letter searches may fail; skip and continue
      }
    }
  } catch (e) {
    logger.warn("Lastname search discovery failed — continuing with partial results", {
      event: "schema_discovery_lastname_failed",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  logger.info("User field discovery complete", {
    event: "schema_discovery_complete",
    standardFieldCount: Object.keys(standard).length,
    customFieldCount: Object.keys(custom).length,
  });

  return { standard, custom };
}

// ─── Type inference ───────────────────────────────────────────────────────────

/**
 * Infer a field type from an observed value.
 * Special cases: unix timestamps (large integers), booleans, null → "string" fallback.
 */
function inferType(key: string, value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    // Unix timestamps are large integers (≥ 1e9 seconds since epoch)
    if (value >= 1e9 && isTimestampKey(key)) return "timestamp";
    return "number";
  }
  // Moodle returns timestamps as numbers, but if we ever see strings, handle it
  if (typeof value === "string" && isTimestampKey(key)) return "timestamp";
  // Everything else (string, null, undefined, object, array) → "string"
  // Null/undefined mean the field exists but has no value — type is inferred
  // from the field name or defaults to string.
  if (value === null || value === undefined) {
    return isTimestampKey(key) ? "timestamp" : "string";
  }
  return "string";
}

function isTimestampKey(key: string): boolean {
  return key === "firstaccess" || key === "lastaccess" || key === "lastcourseaccess";
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge discovered fields + defaults + existing operator overrides into a schema.
 *
 * @param discovered - Raw field discovery result
 * @param siteUrl - Moodle site URL
 * @param moodleVersion - Moodle version string
 * @param existingSchema - Optional existing schema (preserves operator overrides)
 * @param schemaVersion - Version number for the new schema
 */
export function mergeSchema(
  discovered: DiscoveredFields,
  siteUrl: string,
  moodleVersion: string,
  existingSchema?: UserFieldSchema | null,
  schemaVersion?: number,
): UserFieldSchema {
  const userFields: Record<string, UserFieldDef> = {};
  const existingFields = existingSchema?.userFields ?? {};

  // Merge standard fields
  for (const [key, type] of Object.entries(discovered.standard)) {
    const defaults = getDefaults(key);
    const existing = existingFields[key];

    userFields[key] = {
      name: existing?.name ?? formatFieldName(key),
      type: existing?.type ?? type,
      source: "standard",
      // Preserve operator overrides, fall back to defaults
      display: existing?.display ?? defaults.display,
      filterable: existing?.filterable ?? defaults.filterable,
      displayOrder: existing?.displayOrder ?? defaults.displayOrder,
    };
  }

  // Merge custom fields
  for (const [shortname, info] of Object.entries(discovered.custom)) {
    const defaults = getDefaults(shortname);
    const existing = existingFields[shortname];

    userFields[shortname] = {
      name: existing?.name ?? info.name,
      type: existing?.type ?? info.type,
      source: "custom",
      display: existing?.display ?? defaults.display,
      filterable: existing?.filterable ?? defaults.filterable,
      displayOrder: existing?.displayOrder ?? defaults.displayOrder,
    };
  }

  const version = schemaVersion ?? (existingSchema ? existingSchema.schemaVersion + 1 : 1);

  return {
    schemaVersion: version,
    generatedAt: new Date().toISOString(),
    siteUrl,
    moodleVersion,
    userFields,
  };
}

/**
 * Convert a field key into a human-readable name using a lookup table.
 * Falls back to formatting the key if not in the table.
 */
function formatFieldName(key: string): string {
  const known: Record<string, string> = {
    id: "User ID",
    username: "Username",
    firstname: "First Name",
    lastname: "Last Name",
    fullname: "Full Name",
    email: "Email",
    idnumber: "ID Number",
    department: "Department",
    institution: "Institution",
    city: "City",
    country: "Country",
    firstaccess: "First Access",
    lastaccess: "Last Access",
    lastcourseaccess: "Last Course Access",
    auth: "Auth Method",
    confirmed: "Confirmed",
    suspended: "Suspended",
    lang: "Language",
    theme: "Theme",
    timezone: "Timezone",
    mailformat: "Mail Format",
    maildisplay: "Mail Display",
    trackforums: "Track Forums",
    description: "Description",
    descriptionformat: "Description Format",
    profileimageurl: "Profile Image URL",
    profileimageurlsmall: "Profile Image (Small)",
    phone1: "Phone",
    phone2: "Mobile Phone",
    address: "Address",
    roles: "Roles",
    groups: "Groups",
    enrolledcourses: "Enrolled Courses",
    preferences: "Preferences",
  };
  return known[key] ?? formatKey(key);
}

/**
 * Fallback formatter for unknown keys: camelCase → Title Case, snake_case → Title Case.
 */
function formatKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Compare two schemas and report what changed.
 */
export function diffSchemas(
  oldSchema: UserFieldSchema,
  newSchema: UserFieldSchema,
): SchemaDiff {
  const oldKeys = new Set(Object.keys(oldSchema.userFields));
  const newKeys = new Set(Object.keys(newSchema.userFields));

  const added: string[] = [];
  const removed: string[] = [];
  const typeChanged: Array<{ key: string; from: string; to: string }> = [];
  const unchanged: string[] = [];

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      added.push(key);
    } else {
      const oldField = oldSchema.userFields[key];
      const newField = newSchema.userFields[key];
      if (oldField.type !== newField.type) {
        typeChanged.push({ key, from: oldField.type, to: newField.type });
      } else {
        unchanged.push(key);
      }
    }
  }

  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      removed.push(key);
    }
  }

  return { added: added.sort(), removed: removed.sort(), typeChanged, unchanged: unchanged.sort() };
}

// ─── Updates ──────────────────────────────────────────────────────────────────

/**
 * Apply operator updates to a schema. Only mutates the fields provided.
 * Rejects unknown field keys.
 */
export function applyUpdates(
  schema: UserFieldSchema,
  updates: Record<string, { display?: boolean; filterable?: boolean }>,
): SchemaUpdateResult {
  const changed: string[] = [];
  const unknown: string[] = [];

  for (const [key, update] of Object.entries(updates)) {
    if (!schema.userFields[key]) {
      unknown.push(key);
      continue;
    }

    const field = schema.userFields[key];
    let fieldChanged = false;

    if (update.display !== undefined && update.display !== field.display) {
      field.display = update.display;
      fieldChanged = true;
    }
    if (update.filterable !== undefined && update.filterable !== field.filterable) {
      field.filterable = update.filterable;
      fieldChanged = true;
    }

    if (fieldChanged) {
      changed.push(key);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown field key(s): ${unknown.join(", ")}. ` +
      `Known fields: ${Object.keys(schema.userFields).sort().join(", ")}`,
    );
  }

  return { schema, changed };
}

// ─── Reordering ───────────────────────────────────────────────────────────────

function getDisplayOrderValue(key: string, schema: UserFieldSchema): number {
  return schema.userFields[key].displayOrder ?? getDefaults(key).displayOrder ?? Number.MAX_SAFE_INTEGER;
}

export function getFieldSortOrderValue(key: string, schema: UserFieldSchema): number {
  return getDisplayOrderValue(key, schema);
}

function sortedDisplayKeys(schema: UserFieldSchema): string[] {
  return Object.entries(schema.userFields)
    .filter(([, def]) => def.display)
    .map(([key]) => key)
    .sort((a, b) => {
      const orderDiff = getDisplayOrderValue(a, schema) - getDisplayOrderValue(b, schema);
      if (orderDiff !== 0) return orderDiff;
      return schema.userFields[a].name.localeCompare(schema.userFields[b].name) || a.localeCompare(b);
    });
}

export function normalizeDisplayOrder(schema: UserFieldSchema, orderedKeys?: string[]): void {
  const keys = orderedKeys ?? sortedDisplayKeys(schema);
  keys.forEach((key, index) => {
    schema.userFields[key].displayOrder = (index + 1) * 10;
  });
}

export function reorderDisplayField(
  schema: UserFieldSchema,
  input: {
    field: string;
    position?: "start" | "end";
    before?: string;
    after?: string;
  },
): SchemaReorderResult {
  const { field, position, before, after } = input;

  if (!schema.userFields[field]) {
    throw new Error(`Unknown field key: ${field}`);
  }

  const targets = [position, before, after].filter((value) => value !== undefined);
  if (targets.length !== 1) {
    throw new Error("Provide exactly one reorder target: position, before, or after.");
  }

  if (before && !schema.userFields[before]) {
    throw new Error(`Unknown before field key: ${before}`);
  }
  if (after && !schema.userFields[after]) {
    throw new Error(`Unknown after field key: ${after}`);
  }

  schema.userFields[field].display = true;

  const currentOrder = sortedDisplayKeys(schema).filter((key) => key !== field);
  let nextOrder: string[];

  if (position === "start") {
    nextOrder = [field, ...currentOrder];
  } else if (position === "end") {
    nextOrder = [...currentOrder, field];
  } else if (before) {
    if (!schema.userFields[before].display) {
      throw new Error(`Cannot place ${field} before hidden field ${before}. Show ${before} first.`);
    }
    const targetIndex = currentOrder.indexOf(before);
    nextOrder = [...currentOrder.slice(0, targetIndex), field, ...currentOrder.slice(targetIndex)];
  } else {
    if (!schema.userFields[after!].display) {
      throw new Error(`Cannot place ${field} after hidden field ${after}. Show ${after} first.`);
    }
    const targetIndex = currentOrder.indexOf(after!);
    nextOrder = [...currentOrder.slice(0, targetIndex + 1), field, ...currentOrder.slice(targetIndex + 1)];
  }

  const beforeOrders = new Map(nextOrder.map((key) => [key, schema.userFields[key].displayOrder]));
  normalizeDisplayOrder(schema, nextOrder);
  const changed = nextOrder.filter((key) => beforeOrders.get(key) !== schema.userFields[key].displayOrder);

  return {
    schema,
    changed,
    order: getDisplayFieldDefs(schema),
  };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

/**
 * Return field definitions for fields marked display:true, in display order.
 */
export function getDisplayFieldDefs(schema: UserFieldSchema): DisplayFieldDef[] {
  return sortedDisplayKeys(schema).map((key) => ({
    key,
    label: schema.userFields[key].name,
    source: schema.userFields[key].source,
    type: schema.userFields[key].type,
    displayOrder: schema.userFields[key].displayOrder,
  }));
}

export function getDisplayFields(schema: UserFieldSchema): Array<{ key: string; label: string }> {
  return getDisplayFieldDefs(schema).map(({ key, label }) => ({ key, label }));
}

/**
 * Format a user's custom fields into a simple key→value map.
 */
export function normalizeCustomFields(
  customfields?: Array<{ shortname: string; value: string; type: string }>,
): Record<string, string | boolean | null> {
  if (!customfields) return {};
  const result: Record<string, string | boolean | null> = {};

  for (const cf of customfields) {
    if (cf.type === "checkbox") {
      result[cf.shortname] = cf.value === "1";
    } else {
      result[cf.shortname] = cf.value || null;
    }
  }

  return result;
}
