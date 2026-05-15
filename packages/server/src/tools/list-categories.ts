import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolResponse } from "./response-types.js";
import { getCategories, getCourses } from "./cache.js";

/**
 * list_categories — List all LMS categories visible to the configured API token.
 *
 * Session cache: fetched once at startup, reused across all calls.
 * Course counts are joined from the pre-warmed course cache at zero cost.
 */

export const name = "list_categories";

export const description =
  "List all LMS categories. Returns category ID, name, description, " +
  "parent category, path, depth, and course count per category. " +
  "Supports filtering by parent ID, exact parent name, and pagination. " +
  "Use this to discover available categories, identify active vs inactive categories, " +
  "and filter courses by category. Use the exact category ID when querying category-scoped tools."; 

export const inputSchema = z.object({
  /** Optional: filter by parent category ID */
  parent: z
    .number()
    .int()
    .optional()
    .describe("Deprecated alias for parentid. Filter categories by parent category ID (0 = top-level)"),
  /** Optional: filter by parent category ID */
  parentid: z
    .number()
    .int()
    .optional()
    .describe("Filter categories by parent category ID (0 = top-level)"),
  /** Optional: filter by exact parent category name */
  parentname: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Filter categories by exact parent category name"),
  /** Optional: max categories to return */
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Maximum categories to return"),
  /** Optional: pagination offset */
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Pagination offset"),
});

function normalizeCategoryName(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function createHandler(client: MoodleClient, _caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      parent?: number;
      parentid?: number;
      parentname?: string;
      limit: number;
      offset: number;
    };

    const categories = await getCategories(client);
    const categoryById = new Map(categories.map((category) => [category.id, category]));

    const requestedParentId = parsed.parentid ?? parsed.parent;
    let resolvedParentId = requestedParentId;
    let resolvedParentName: string | null = null;
    let resolvedParentPath: string | null = null;

    if (parsed.parentname) {
      const normalizedRequestedName = normalizeCategoryName(parsed.parentname);
      const matchingParents = categories.filter(
        (category) => normalizeCategoryName(category.name) === normalizedRequestedName
      );

      if (matchingParents.length === 0) {
        return buildToolResponse({
          ok: false,
          error: {
            code: "parent_category_not_found",
            message: `No category named "${parsed.parentname}" was found.`,
            kind: "not_found",
            canRetry: true,
            actionRequired: "Call list_categories without a parent filter and use the exact category name or ID from the returned rows.",
          },
          meta: {
            tool: name,
            title: "LMS Categories",
            entity: "category_catalog",
            resultCount: 0,
          },
          data: {
            kind: "none",
            title: "No data returned",
          },
          context: {
            summary: `No category named "${parsed.parentname}" was found.`,
            suggestedQueries: [
              "List top-level categories",
              "Use the exact category ID from this list",
            ],
          },
        });
      }

      if (matchingParents.length > 1) {
        return buildToolResponse({
          ok: false,
          error: {
            code: "parent_category_ambiguous",
            message: `Multiple categories named "${parsed.parentname}" were found.`,
            kind: "validation",
            canRetry: true,
            actionRequired: "Retry with parentid or use the exact parent path from the returned rows.",
          },
          meta: {
            tool: name,
            title: "LMS Categories",
            entity: "category_catalog",
            resultCount: 0,
          },
          data: {
            kind: "none",
            title: "No data returned",
          },
          context: {
            summary: `Parent category name "${parsed.parentname}" is ambiguous. Use the category ID instead of guessing.`,
            highlights: matchingParents.map(
              (category) => `Category ${category.id}: ${category.name} (${category.path})`
            ),
            suggestedQueries: [
              "List top-level categories",
              "Use the exact category ID from this list",
            ],
          },
        });
      }

      resolvedParentId = matchingParents[0].id;
      resolvedParentName = matchingParents[0].name;
      resolvedParentPath = matchingParents[0].path;
    }

    if (
      requestedParentId != null &&
      parsed.parentname != null &&
      resolvedParentId != null &&
      requestedParentId !== resolvedParentId
    ) {
      const actualParent = categoryById.get(requestedParentId);
      return buildToolResponse({
        ok: false,
        error: {
          code: "parent_id_name_mismatch",
          message: `parentid ${requestedParentId} does not match parentname "${parsed.parentname}".`,
          kind: "validation",
          canRetry: true,
          actionRequired: "Retry with a matching parentid/parentname pair or provide only one of them.",
        },
        meta: {
          tool: name,
          title: "LMS Categories",
          entity: "category_catalog",
          resultCount: 0,
        },
        data: {
          kind: "none",
          title: "No data returned",
        },
        context: {
          summary: `parentid ${requestedParentId} does not match parentname "${parsed.parentname}".`,
          highlights: actualParent
            ? [`Category ${requestedParentId} is "${actualParent.name}" (${actualParent.path}).`]
            : undefined,
          suggestedQueries: [
            "List top-level categories",
            "Use the exact category ID from this list",
          ],
        },
      });
    }

    if (resolvedParentId != null && resolvedParentId !== 0) {
      const resolvedParent = categoryById.get(resolvedParentId);
      resolvedParentName = resolvedParent?.name ?? resolvedParentName;
      resolvedParentPath = resolvedParent?.path ?? resolvedParentPath;
    } else if (resolvedParentId === 0) {
      resolvedParentName = "Top Level";
      resolvedParentPath = "/";
    }

    const courses = await getCourses(client);
    const courseCountByCategory = new Map<number, number>();
    for (const c of courses) {
      if (c.categoryid != null) {
        courseCountByCategory.set(
          c.categoryid,
          (courseCountByCategory.get(c.categoryid) ?? 0) + 1,
        );
      }
    }

    const filtered =
      resolvedParentId !== undefined
        ? categories.filter((c) => c.parent === resolvedParentId)
        : categories;

    const paged = filtered.slice(parsed.offset, parsed.offset + parsed.limit);

    const rows = paged.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description?.substring(0, 200) ?? null,
      parent: c.parent,
      path: c.path,
      depth: c.depth,
      courseCount: courseCountByCategory.get(c.id) ?? 0,
    }));

    const activeCount = filtered.filter(
      (c) => (courseCountByCategory.get(c.id) ?? 0) > 0,
    ).length;
    const inactiveCount = filtered.length - activeCount;

    return buildToolResponse({
      meta: {
        tool: name,
        title: resolvedParentId !== undefined
          ? `Categories under ${resolvedParentName ?? `parent ${resolvedParentId}`}`
          : "LMS Categories",
        resultCount: rows.length,
        entity: "category_catalog",
        ...(resolvedParentId !== undefined ? { entityId: resolvedParentId } : {}),
      },
      data: {
        kind: "table",
        title: resolvedParentId !== undefined
          ? `Categories under ${resolvedParentName ?? `parent ${resolvedParentId}`}`
          : "LMS Categories",
        columns: [
          { key: "id", label: "Category ID" },
          { key: "name", label: "Category Name" },
          { key: "courseCount", label: "Courses" },
          { key: "parent", label: "Parent ID" },
          { key: "path", label: "Path" },
          { key: "depth", label: "Depth" },
        ],
        rows,
        pagination: {
          offset: parsed.offset,
          limit: parsed.limit,
          total: filtered.length,
          hasMore: parsed.offset + parsed.limit < filtered.length,
        },
      },
      resolution: {
        scope:
          resolvedParentId === 0
            ? "top_level"
            : resolvedParentId != null
              ? "children_of_parent"
              : "all",
        resolvedParentId: resolvedParentId ?? null,
        resolvedParentName,
        resolvedParentPath,
      },
      context: {
        summary:
          `Showing ${rows.length} of ${filtered.length} categories${resolvedParentId !== undefined ? ` under ${resolvedParentName ?? `parent ${resolvedParentId}`} (ID ${resolvedParentId})` : ""}. ` +
          `${activeCount} active (have courses), ${inactiveCount} inactive (empty).`,
        metrics: {
          returned: rows.length,
          total: filtered.length,
          active: activeCount,
          inactive: inactiveCount,
          parentid: resolvedParentId ?? null,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        highlights:
          resolvedParentId !== undefined
            ? [
                `Resolved parent: ${resolvedParentName ?? `parent ${resolvedParentId}`} (ID ${resolvedParentId})`,
                `Parent path: ${resolvedParentPath ?? "unknown"}`,
              ]
            : undefined,
        suggestedQueries: [
          "List top-level categories",
          "Show categories with no courses",
          "Use the exact category ID from this list",
          "Filter courses by category [Category ID]",
          "List sub categories under [Parent Category Name]",
          "List categories under parent [Parent ID]",
        ],
        fields: ["id", "name", "courseCount", "parent", "path", "depth"],
      },
    });
  };
}
