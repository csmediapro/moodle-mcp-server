import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolErrorResponse, buildToolResponse } from "./response-types.js";
import { getCategories, getCourses } from "./cache.js";

export const name = "search_courses_by_name";

export const description =
  "Search for courses by name, returning matching courses with their IDs and details. " +
  "Useful for finding course IDs when you only know part of the course name. " +
  "Supports partial matching on course full name, short name, and ID number. " +
  "Case-insensitive search. Returns course ID, full name, short name, category, and visibility. " +
  "Use this to find course IDs for other tools like list_course_users.";

export const inputSchema = z.object({
  /** Search term to match against course names */
  searchTerm: z
    .string()
    .trim()
    .min(1)
    .describe("Search term to match against course names (case-insensitive partial match)"),
  /** Optional: max results to return */
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Maximum number of matching courses to return"),
});

/**
 * Search courses by name using cached data
 * @param courses Cached course data
 * @param categories Cached category data
 * @param searchTerm Search term to match
 * @param limit Maximum results to return
 * @returns Array of matching courses with category info
 */
export function searchCoursesByName(
  courses: Array<{
    id: number;
    fullname: string;
    shortname: string;
    categoryid?: number;
    visible: number;
    enablecompletion?: number;
  }>,
  categories: Array<{
    id: number;
    name: string;
    description: string;
    parent: number;
    depth: number;
    path: string;
  }>,
  searchTerm: string,
  limit: number
): Array<{
  id: number;
  fullname: string;
  shortname: string;
  categoryid: number | null;
  categoryname: string | null;
  visible: boolean;
}> {
  // Build category name lookup: id → name
  const categoryNameMap = new Map<number, string>();
  for (const cat of categories) {
    categoryNameMap.set(cat.id, cat.name);
  }

  // Normalize search term for case-insensitive matching
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();

  // Score and filter courses
  const scoredCourses = courses
    .map(course => {
      // Calculate match score for sorting
      let score = 0;
      const normalizedFullname = course.fullname.toLowerCase();
      const normalizedShortname = course.shortname.toLowerCase();
      
      // Exact match scores highest
      if (normalizedFullname === normalizedSearchTerm) score += 100;
      else if (normalizedFullname.includes(normalizedSearchTerm)) score += 50;
      
      if (normalizedShortname === normalizedSearchTerm) score += 100;
      else if (normalizedShortname.includes(normalizedSearchTerm)) score += 50;
      
      // Bonus for matches at word boundaries
      if (normalizedFullname.match(new RegExp(`\\b${normalizedSearchTerm}\\b`, 'i'))) score += 25;
      if (normalizedShortname.match(new RegExp(`\\b${normalizedSearchTerm}\\b`, 'i'))) score += 25;
      
      return { course, score };
    })
    .filter(({ score }) => score > 0) // Only keep matches
    .sort((a, b) => b.score - a.score) // Sort by score (highest first)
    .slice(0, limit) // Apply limit
    .map(({ course }) => ({
      id: course.id,
      fullname: course.fullname,
      shortname: course.shortname,
      categoryid: course.categoryid ?? null,
      categoryname: course.categoryid != null ? (categoryNameMap.get(course.categoryid) ?? null) : null,
      visible: course.visible === 1,
    }));

  return scoredCourses;
}

export function createHandler(client: MoodleClient, _caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      searchTerm: string;
      limit: number;
    };

    try {
      const courses = await getCourses(client);
      const categories = await getCategories(client);

      const matchingCourses = searchCoursesByName(courses, categories, parsed.searchTerm, parsed.limit);

      if (matchingCourses.length === 0) {
        return buildToolResponse({
          meta: {
            tool: name,
            title: `Course Search - "${parsed.searchTerm}"`,
            entity: "course_search",
            resultCount: 0,
          },
          data: {
            kind: "table",
            title: `Course Search - "${parsed.searchTerm}"`,
            columns: [
              { key: "id", label: "Course ID" },
              { key: "fullname", label: "Full Name" },
              { key: "shortname", label: "Short Name" },
              { key: "categoryname", label: "Category" },
              { key: "visible", label: "Visible" },
            ],
            rows: [],
          },
          context: {
            summary: `No courses found matching "${parsed.searchTerm}".`,
            metrics: {
              searchTerm: parsed.searchTerm,
              returned: 0,
              total: 0,
            },
            suggestedQueries: [
              "Try a different search term",
              "List the first [N] courses to browse",
              "List categories to find courses by category",
            ],
            fields: ["id", "fullname", "shortname", "categoryname", "visible"],
          },
        });
      }

      return buildToolResponse({
        meta: {
          tool: name,
          title: `Course Search - "${parsed.searchTerm}"`,
          entity: "course_search",
          resultCount: matchingCourses.length,
        },
        data: {
          kind: "table",
          title: `Course Search - "${parsed.searchTerm}"`,
          columns: [
            { key: "id", label: "Course ID" },
            { key: "fullname", label: "Full Name" },
            { key: "shortname", label: "Short Name" },
            { key: "categoryname", label: "Category" },
            { key: "visible", label: "Visible" },
          ],
          rows: matchingCourses,
        },
        context: {
          summary: `Found ${matchingCourses.length} course${matchingCourses.length !== 1 ? 's' : ''} matching "${parsed.searchTerm}".`,
          metrics: {
            searchTerm: parsed.searchTerm,
            returned: matchingCourses.length,
            total: matchingCourses.length,
          },
          highlights: [
            `Use the course ID from the first column with tools like list_course_users`,
          ],
          suggestedQueries: [
            "Show users in course [Course ID]",
            "Get details for course [Course ID]",
            "Try a different search term",
          ],
          fields: ["id", "fullname", "shortname", "categoryname", "visible"],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildToolErrorResponse({
        error: {
          code: "course_search_failed",
          message: `Failed to search courses: ${message}`,
          kind: "upstream",
          canRetry: true,
          actionRequired: "Check the Moodle API connection and try again.",
        },
        summary: `I could not search for courses due to an error: ${message}`,
        meta: {
          tool: name,
          title: `Course Search - "${parsed.searchTerm}"`,
          entity: "course_search",
          resultCount: 0,
        },
        suggestedQueries: [
          "List the first [N] courses",
          "List categories to find courses by category",
        ],
      });
    }
  };
}