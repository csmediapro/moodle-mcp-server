import { MoodleClient } from "../moodle/client.js";

/**
 * Shared session cache for categories and courses.
 *
 * Both list-categories.ts and list-courses.ts import from here
 * to avoid a circular dependency. Caches are filled once on first
 * access and reused for the lifetime of the server process.
 *
 * Startup warming: main() calls warmupCaches() before registering
 * tools, so the first tool call never pays the fetch cost.
 */

/* ── Categories ──────────────────────────────────────── */

let categoryCache: Array<{
  id: number;
  name: string;
  description: string;
  parent: number;
  depth: number;
  path: string;
}> | null = null;

export async function getCategories(client: MoodleClient) {
  if (categoryCache) return categoryCache;

  categoryCache = await client.call<
    Array<{
      id: number;
      name: string;
      description: string;
      parent: number;
      depth: number;
      path: string;
    }>
  >({
    wsfunction: "core_course_get_categories",
    // No criteria — return all categories the token can see.
    // Passing empty criteria strings triggers a search permission check
    // which fails for restricted tokens.
  });

  return categoryCache;
}

/* ── Courses ─────────────────────────────────────────── */

let courseCache: Array<{
  id: number;
  fullname: string;
  shortname: string;
  categoryid?: number;
  visible: number;
  enablecompletion?: number;
}> | null = null;

export async function getCourses(client: MoodleClient) {
  if (courseCache) return courseCache;

  courseCache = await client.call<
    Array<{
      id: number;
      fullname: string;
      shortname: string;
      categoryid?: number;
      visible: number;
      enablecompletion?: number;
    }>
  >({
    wsfunction: "core_course_get_courses_by_field",
    responseKey: "courses",
  });

  return courseCache;
}

/* ── Warmup ──────────────────────────────────────────── */

/**
 * Pre-fill both caches at startup so the first tool call is instant.
 * Called from main() in the server entry point.
 */
export async function warmupCaches(client: MoodleClient) {
  await Promise.all([getCategories(client), getCourses(client)]);
}
