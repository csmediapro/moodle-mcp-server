import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolResponse } from "./response-types.js";
import { clearCache, refreshCache } from "./cache.js";

/**
 * manage_cache — Manage the Moodle course and category caches.
 *
 * Allows operators to refresh or clear the in-memory and persistent caches
 * to ensure data freshness or free up memory.
 */
export const name = "manage_cache";

export const description =
  "Manage the Moodle course and category caches. " +
  "Allows refreshing or clearing the in-memory and persistent caches " +
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
        await refreshCache(client, target);
        return buildToolResponse({
          meta: {
            tool: name,
            title: "Cache Management",
            resultCount: 1,
            entity: "cache_management",
          },
          data: {
            kind: "none",
            title: "Cache Refreshed",
          },
          context: {
            summary: `Successfully refreshed ${target} cache${target === "all" ? "s" : ""} from Moodle.`,
            highlights: [`Refreshed ${target} cache${target === "all" ? "s" : ""}`],
            suggestedQueries: [
              "List courses",
              "List categories",
              "Refresh courses cache",
              "Clear categories cache"
            ],
          },
        });
      } else if (action === "clear") {
        await clearCache(target);
        return buildToolResponse({
          meta: {
            tool: name,
            title: "Cache Management",
            resultCount: 1,
            entity: "cache_management",
          },
          data: {
            kind: "none",
            title: "Cache Cleared",
          },
          context: {
            summary: `Successfully cleared ${target} cache${target === "all" ? "s" : ""}.`,
            highlights: [`Cleared ${target} cache${target === "all" ? "s" : ""}`],
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