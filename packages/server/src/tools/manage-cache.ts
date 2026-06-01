import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolResponse } from "./response-types.js";
import { clearCache, refreshCache } from "./cache.js";

/**
 * manage_cache — Manage the Moodle course and category caches.
 *
 * Allows operators to refresh or clear the in-memory and file-backed caches
 * to ensure data freshness or free up memory.
 */
export const name = "manage_cache";

export const description =
  "Manage the Moodle course and category caches. " +
  "Allows refreshing or clearing the in-memory and file-backed caches " +
  "to ensure data freshness or free up memory. " +
  "Use 'refresh' to update cache with latest data from Moodle, " +
  "'clear' to remove cached data, and 'all' to affect both courses and categories.";

export const inputSchema = z.object({
  /** Action to perform: refresh or clear */
  action: z
    .enum(["refresh", "clear"])
    .describe("Action to perform: refresh (update cache) or clear (remove cache)"),
  /** Target to affect: courses, categories, or all */
  target: z
    .enum(["courses", "categories", "all"])
    .optional()
    .default("all")
    .describe("Target to affect: courses, categories, or all"),
});

export function createHandler(client: MoodleClient, _caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as {
      action: "refresh" | "clear";
      target: "courses" | "categories" | "all";
    };

    const { action, target } = parsed;

    try {
      if (action === "refresh") {
        const results = await refreshCache(client, target);
        const highlights = results.map((result) =>
          `${result.target}: fetched ${result.count} item${result.count === 1 ? "" : "s"} from Moodle`
        );

        return buildToolResponse({
          meta: {
            tool: name,
            title: "Cache Management",
            resultCount: results.length,
            entity: "cache_management",
          },
          data: {
            kind: "none",
            title: "Cache Refreshed",
          },
          context: {
            summary: `Refreshed ${target} cache${target === "all" ? "s" : ""} from Moodle and updated the file-backed cache.`,
            highlights,
            suggestedQueries: [
              "List courses",
              "List categories",
              "Refresh courses cache",
              "Clear categories cache"
            ],
          },
        });
      } else if (action === "clear") {
        const results = await clearCache(target);
        const highlights = results.map((result) => {
          const cleared = [
            result.memoryCleared ? "memory" : null,
            result.persistentCleared ? "file" : null,
          ].filter(Boolean).join(" + ");
          return `${result.target}: cleared ${cleared || "nothing cached"}`;
        });

        return buildToolResponse({
          meta: {
            tool: name,
            title: "Cache Management",
            resultCount: results.length,
            entity: "cache_management",
          },
          data: {
            kind: "none",
            title: "Cache Cleared",
          },
          context: {
            summary: `Cleared ${target} cache${target === "all" ? "s" : ""} from memory and disk where present.`,
            highlights,
            suggestedQueries: [
              "Refresh all cache",
              "Refresh courses cache",
              "List courses",
              "List categories"
            ],
          },
        });
      }

      // This should never happen due to Zod validation
      throw new Error(`Unknown action: ${action}`);
    } catch (error) {
      return buildToolResponse({
        meta: {
          tool: name,
          title: "Cache Management Error",
          resultCount: 0,
          entity: "cache_management",
        },
        data: {
          kind: "none",
          title: "Cache Management Failed",
        },
        context: {
          summary: `Error ${action}ing ${target} cache: ${error instanceof Error ? error.message : String(error)}`,
          highlights: [`Error: ${error instanceof Error ? error.message : String(error)}`],
          suggestedQueries: [
            "Try again",
            "List courses",
            "List categories"
          ],
        },
      });
    }
  };
}
