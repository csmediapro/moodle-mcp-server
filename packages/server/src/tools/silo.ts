/**
 * Silo filtering utilities — shared by all tools that return user data.
 *
 * When _silo is present in a tool's arguments (injected by agent-edge for
 * sub-users), the tool filters results to only include users whose custom
 * field matches the silo constraint.
 *
 * When _silo is absent (standalone moodle-mcp-server, or admin user),
 * no filtering occurs — tools behave exactly as they did before.
 */

export interface SiloConstraint {
  field: string;
  value: string;
}

/**
 * Custom field shape as returned by Moodle's API.
 */
interface MoodleCustomField {
  type?: string;
  value: string | number | boolean | null;
  name?: string;
  shortname: string;
}

/**
 * Extract _silo from tool arguments, or null if not present.
 * Used at the top of each tool handler.
 */
export function extractSilo(args: Record<string, unknown>): SiloConstraint | null {
  if (!args._silo || typeof args._silo !== "object") return null;
  const silo = args._silo as { field?: string; value?: string };
  if (!silo.field || silo.value === undefined || silo.value === null) return null;
  return { field: silo.field, value: String(silo.value) };
}

/**
 * Strip _silo from arguments before passing to Moodle.
 * Moodle doesn't know what _silo is and would reject it.
 */
export function stripSilo<T extends Record<string, unknown>>(args: T): Omit<T, "_silo"> {
  const { _silo: _removed, ...rest } = args;
  return rest;
}

/**
 * Check if a single user matches the silo constraint.
 *
 * Accepts either raw Moodle customfields (array of {shortname, value})
 * or a normalized record (shortname → value).
 *
 * - If the user has the silo field and it matches the value → true
 * - If the user has the silo field and it does NOT match → false
 * - If the user does NOT have the silo field at all → false (strict mode)
 *
 * @param customfields  Either raw Moodle array or normalized record
 * @param silo          The silo constraint
 * @param strict        If true (default), users without the field are excluded.
 *                      If false, users without the field are included.
 */
export function matchesSilo(
  customfields: MoodleCustomField[] | Record<string, unknown> | undefined,
  silo: SiloConstraint,
  strict: boolean = true,
): boolean {
  const fields = normalizeCustomFields(customfields);
  if (!(silo.field in fields)) {
    return !strict;
  }
  return fields[silo.field] === silo.value;
}

/**
 * Normalize custom fields from either raw Moodle array or already-normalized record.
 */
function normalizeCustomFields(customfields: MoodleCustomField[] | Record<string, unknown> | undefined): Record<string, string> {
  if (!customfields) return {};
  if (Array.isArray(customfields)) {
    const map: Record<string, string> = {};
    for (const f of customfields) {
      map[f.shortname] = f.value == null ? "" : String(f.value);
    }
    return map;
  }

  return Object.fromEntries(
    Object.entries(customfields).map(([key, value]) => [
      key,
      value == null ? "" : String(value),
    ]),
  );
}

/**
 * Filter an array of users by silo constraint.
 * Users must have a customfields property (either raw array or normalized record).
 *
 * @param users         Array of user objects with optional customfields
 * @param silo          The silo constraint, or null to skip filtering
 * @param strict        Strict mode (default true)
 * @returns             Filtered array, or original if silo is null
 */
export function filterUsersBySilo<T extends { customfields?: MoodleCustomField[] | Record<string, unknown> | undefined }>(
  users: T[],
  silo: SiloConstraint | null,
  strict: boolean = true,
): T[] {
  if (!silo) return users;
  return users.filter((u) => matchesSilo(u.customfields, silo, strict));
}
