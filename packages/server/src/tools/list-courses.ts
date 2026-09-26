import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolErrorResponse, buildToolResponse } from "./response-types.js";
import { getCategories, getCourses } from "./cache.js";

/**
 * list_courses — List courses available to the configured API token.
 *
 * Session cache: the course list is fetched once and cached in memory.
 * Moodle's core_course_get_courses_by_field returns all courses (no WS-level
 * pagination), so repeated fetches would waste 1.7MB + 20-50s per call.
 */
export const name = "list_courses";

export const description =
  "List LMS courses available to the configured API token. " +
  "Returns course ID, full name, short name, category, category path, and visibility. " +
  "Supports filtering and pagination via categoryid, categoryname, visible, limit, and offset. " +
  "When categoryname is used, it must match an existing category name exactly; if multiple categories share that name, the tool will ask for the ID instead of guessing. " +
  "Use visible=false for hidden courses and visible=true for visible courses. Use limit and offset for subset requests like first 10 or first 50. " +
  "Do not request the full course list unless the user explicitly asks for all courses. " +
  "Use this to discover available courses before drilling into details. Prefer exact category IDs from list_categories when available.";

export const inputSchema = z.object({
  /** Optional: filter courses by category ID */
  categoryid: z
    .number()
    .int()
    .optional()
    .describe("Filter courses by category ID"),
  /** Optional: filter courses by category name */
  categoryname: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Filter courses by exact category name"),
  /** Optional: max courses to return */
  limit: z
    .number()
    .int()
    .min(1)
    .max(1500)
    .optional()
    .default(20)
    .describe("Maximum number of courses to return"),
  /** Optional: filter by course visibility */
  visible: z
    .boolean()
    .optional()
    .describe("Filter by course visibility. false returns hidden courses; true returns visible courses."),
  /** Optional: pagination offset */
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Number of courses to skip before returning results"),
});

function normalizeCategoryName(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function createHandler(client: MoodleClient, _caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      categoryid?: number;
      categoryname?: string;
      limit: number;
      visible?: boolean;
      offset: number;
    };

    const courses = await getCourses(client);
    const categories = await getCategories(client);

    // Build category name lookup: id → name
    const categoryNameMap = new Map<number, string>();
    const categoryPathMap = new Map<number, string>();
    for (const cat of categories) {
      categoryNameMap.set(cat.id, cat.name);
      categoryPathMap.set(cat.id, cat.path);
    }

    let resolvedCategoryId = parsed.categoryid;
    let resolvedCategoryName = parsed.categoryname?.trim();
    const originalCategoryId = parsed.categoryid;

    if (resolvedCategoryName) {
      const normalizedRequestedName = normalizeCategoryName(resolvedCategoryName);
      const matchingCategories = categories.filter(
        (cat) => normalizeCategoryName(cat.name) === normalizedRequestedName
      );

      if (matchingCategories.length === 0) {
        return buildToolErrorResponse({
          error: {
            code: "category_name_not_found",
            message: `No category named "${resolvedCategoryName}" was found.`,
            kind: "not_found",
            canRetry: true,
            actionRequired: "Call list_categories and use the exact category name or ID from the returned rows.",
          },
          summary: `No category named "${resolvedCategoryName}" was found.`,
          meta: {
            tool: name,
            title: "LMS Courses",
            entity: "course_catalog",
            resultCount: 0,
          },
          suggestedQueries: [
            "List top-level categories",
            "Use the exact category ID from list_categories",
          ],
        });
      }

      if (matchingCategories.length > 1) {
        return buildToolErrorResponse({
          error: {
            code: "category_name_ambiguous",
            message: `Multiple categories named "${resolvedCategoryName}" were found.`,
            kind: "validation",
            canRetry: true,
            actionRequired: "Retry with categoryid or use the full category path context from list_categories.",
          },
          summary: `Category name "${resolvedCategoryName}" is ambiguous. Use the category ID instead of guessing.`,
          meta: {
            tool: name,
            title: "LMS Courses",
            entity: "course_catalog",
            resultCount: 0,
          },
          highlights: matchingCategories.map(
            (cat) => `Category ${cat.id}: ${cat.name} (${cat.path})`
          ),
          suggestedQueries: [
            "List top-level categories",
            "Use the exact category ID from list_categories",
          ],
        });
      }

      resolvedCategoryId = matchingCategories[0].id;
      resolvedCategoryName = matchingCategories[0].name;
    }

    // Guard: if the user supplied both categoryid and categoryname but they
    // point to different categories, reject instead of silently picking one.
    if (
      originalCategoryId != null &&
      resolvedCategoryName != null &&
      categoryNameMap.get(originalCategoryId) != null &&
      normalizeCategoryName(categoryNameMap.get(originalCategoryId) as string) !==
        normalizeCategoryName(resolvedCategoryName)
    ) {
      return buildToolErrorResponse({
        error: {
          code: "category_id_name_mismatch",
          message: `categoryid ${originalCategoryId} does not match categoryname "${resolvedCategoryName}".`,
          kind: "validation",
          canRetry: true,
          actionRequired: "Retry with a matching categoryid/categoryname pair or provide only one of them.",
        },
        summary: `categoryid ${originalCategoryId} does not match categoryname "${resolvedCategoryName}".`,
        meta: {
          tool: name,
          title: "LMS Courses",
          entity: "course_catalog",
          resultCount: 0,
        },
        highlights: [
          `Category ${originalCategoryId} is "${categoryNameMap.get(originalCategoryId)}".`,
        ],
        suggestedQueries: [
          "List top-level categories",
          "Use the exact category ID from list_categories",
        ],
      });
    }

    // Filter by category if requested
    const categoryFiltered = resolvedCategoryId != null
      ? courses.filter((c) => c.categoryid === resolvedCategoryId)
      : courses;
    const filtered = parsed.visible == null
      ? categoryFiltered
      : categoryFiltered.filter((c) => (c.visible === 1) === parsed.visible);

    const offset = parsed.offset ?? 0;
    const limit = parsed.limit ?? 20;
    const paged = filtered.slice(offset, offset + limit);

    const rows = paged.map((c) => ({
      id: c.id,
      fullname: c.fullname,
      shortname: c.shortname,
      categoryid: c.categoryid ?? null,
      categoryname: c.categoryid != null ? (categoryNameMap.get(c.categoryid) ?? null) : null,
      categorypath: c.categoryid != null ? (categoryPathMap.get(c.categoryid) ?? null) : null,
      visible: c.visible === 1,
    }));

    const visibleCount = filtered.filter((c) => c.visible === 1).length;

    return buildToolResponse({
      meta: {
        tool: name,
        title: resolvedCategoryId != null
          ? `Courses in category ${resolvedCategoryName ?? categoryNameMap.get(resolvedCategoryId) ?? resolvedCategoryId}`
          : "LMS Courses",
        resultCount: rows.length,
        entity: resolvedCategoryId != null ? "course_category" : "course_catalog",
        ...(resolvedCategoryId != null ? { entityId: resolvedCategoryId } : {}),
      },
      data: {
        kind: "table",
        title: resolvedCategoryId != null
          ? `Courses in category ${resolvedCategoryName ?? categoryNameMap.get(resolvedCategoryId) ?? resolvedCategoryId}`
          : "LMS Courses",
        columns: [
          { key: "id", label: "Course ID" },
          { key: "fullname", label: "Full Name" },
          { key: "shortname", label: "Short Name" },
          { key: "categoryname", label: "Category" },
          { key: "categorypath", label: "Category Path" },
          { key: "categoryid", label: "Category ID" },
          { key: "visible", label: "Visible" },
        ],
        rows,
        pagination: {
          offset,
          limit,
          total: filtered.length,
          hasMore: offset + limit < filtered.length,
        },
      },
      context: {
        summary:
          `Showing ${rows.length} of ${filtered.length}` +
          (parsed.visible == null ? " courses" : parsed.visible ? " visible courses" : " hidden courses") +
          (resolvedCategoryId != null
            ? ` in category ${resolvedCategoryName ?? categoryNameMap.get(resolvedCategoryId) ?? resolvedCategoryId} (ID ${resolvedCategoryId})`
            : "") +
          `. ${visibleCount} are marked visible.`,
        metrics: {
          returned: rows.length,
          total: filtered.length,
          visible: visibleCount,
          hidden: filtered.length - visibleCount,
          visibilityFilter: parsed.visible ?? null,
          categoryid: resolvedCategoryId ?? null,
          offset,
          limit,
        },
        highlights:
          resolvedCategoryId != null
            ? [
                `Resolved category: ${resolvedCategoryName ?? categoryNameMap.get(resolvedCategoryId) ?? resolvedCategoryId} (ID ${resolvedCategoryId})`,
                `Category path: ${categoryPathMap.get(resolvedCategoryId) ?? "unknown"}`,
              ]
            : undefined,
        suggestedQueries: [
          "Show me the first [N] courses",
          "List hidden courses",
          "List visible courses",
          "Get details for course [Course ID]",
          "Filter courses by category name [Category Name]",
          "Filter courses by category [Category ID]",
          resolvedCategoryId != null
            ? "List assignments in course [Course ID]"
            : "List categories to find the exact category name or ID",
        ],
        fields: ["id", "fullname", "shortname", "categoryname", "categorypath", "categoryid", "visible"],
      },
    });
  };
}
