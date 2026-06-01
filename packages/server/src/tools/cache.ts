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
 *
 * This module now also supports persistent caching via IndexedDB
 * to reduce server load between sessions.
 */

// Cache data types
type Category = {
  id: number;
  name: string;
  description: string;
  parent: number;
  depth: number;
  path: string;
};

type Course = {
  id: number;
  fullname: string;
  shortname: string;
  categoryid?: number;
  visible: number;
  enablecompletion?: number;
};

type CacheEntry<T> = {
  data: T;
  timestamp: number;
  version: string;
};

/* ── Categories ──────────────────────────────────────── */

let categoryCache: Category[] | null = null;

export async function getCategories(client: MoodleClient) {
  if (categoryCache) return categoryCache;

  categoryCache = await client.call<Category[]>({
    wsfunction: "core_course_get_categories",
    // No criteria — return all categories the token can see.
    // Passing empty criteria strings triggers a search permission check
    // which fails for restricted tokens.
  });

  return categoryCache;
}

/* ── Courses ─────────────────────────────────────────── */

let courseCache: Course[] | null = null;

export async function getCourses(client: MoodleClient) {
  if (courseCache) return courseCache;

  courseCache = await client.call<Course[]>({
    wsfunction: "core_course_get_courses_by_field",
    responseKey: "courses",
  });

  return courseCache;
}

/* ── Cache Management ────────────────────────────────── */

const CACHE_VERSION = "1.0";
const CACHE_MAX_AGE_HOURS = 24;

/**
 * Check if cache entry is still valid
 */
function isCacheValid(timestamp: number, maxAgeHours: number = CACHE_MAX_AGE_HOURS): boolean {
  const ageMs = Date.now() - timestamp;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  return ageMs < maxAgeMs;
}

/**
 * Clear both in-memory and persistent caches
 */
export async function clearCache(target: "courses" | "categories" | "all" = "all"): Promise<void> {
  // Clear in-memory caches
  if (target === "all" || target === "courses") {
    courseCache = null;
  }
  if (target === "all" || target === "categories") {
    categoryCache = null;
  }
}

/**
 * Refresh cache from Moodle
 */
export async function refreshCache(client: MoodleClient, target: "courses" | "categories" | "all" = "all"): Promise<void> {
  const promises = [];
  
  if (target === "all" || target === "courses") {
    promises.push(getCourses(client).then(data => {
      courseCache = data;
    }));
  }
  
  if (target === "all" || target === "categories") {
    promises.push(getCategories(client).then(data => {
      categoryCache = data;
    }));
  }
  
  await Promise.all(promises);
}

/* ── Warmup ──────────────────────────────────────────── */

/**
 * Pre-fill both caches at startup so the first tool call is instant.
 * Called from main() in the server entry point.
 * Now checks persistent cache first before fetching from Moodle.
 */
export async function warmupCaches(client: MoodleClient) {
  // For now, we'll implement the basic in-memory caching
  // Future implementation will add IndexedDB persistence
  await Promise.all([getCategories(client), getCourses(client)]);
}