import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { z } from "zod";
import { buildToolResponse } from "./response-types.js";
import { getCacheStatus, type CacheTargetOrAll, type CacheStatus } from "./cache.js";

export const name = "get_cache_status";

export const description =
  "Inspect the Moodle course and category caches without changing them. " +
  "Reports memory load state, disk cache validity, item counts, file size, TTL, timestamps, version, and Moodle site match. " +
  "This tool never calls Moodle and never returns cached course or category records.";

export const inputSchema = z.object({
  target: z
    .enum(["courses", "categories", "all"])
    .optional()
    .default("all")
    .describe("Cache target to inspect: courses, categories, or all"),
});

export function createHandler(client: MoodleClient, _caps: MoodleCapabilities) {
  return async (args: unknown) => {
    const parsed = inputSchema.parse(args) as { target: CacheTargetOrAll };
    const statuses = getCacheStatus(client, parsed.target);

    return buildToolResponse({
      meta: {
        tool: name,
        title: "Cache Status",
        resultCount: statuses.length,
        entity: "cache_status",
      },
      data: {
        kind: "table",
        title: "Cache Status",
        columns: [
          { key: "target", label: "Target" },
          { key: "memory", label: "Memory" },
          { key: "memoryCount", label: "Memory Count" },
          { key: "diskStatus", label: "Disk Status" },
          { key: "diskCount", label: "Disk Count" },
          { key: "ttlRemainingMinutes", label: "TTL Remaining (min)" },
          { key: "bytes", label: "Bytes" },
          { key: "updatedAt", label: "Updated At" },
          { key: "path", label: "Path" },
        ],
        rows: statuses.map((status) => ({
          target: status.target,
          memory: status.memory.loaded ? "loaded" : "empty",
          memoryCount: status.memory.count,
          diskStatus: status.disk.status,
          diskCount: status.disk.count,
          ttlRemainingMinutes: status.disk.ttlRemainingMinutes,
          bytes: status.disk.bytes,
          updatedAt: status.disk.updatedAt,
          path: status.disk.path,
        })),
      },
      context: {
        summary: summarizeStatuses(statuses),
        metrics: buildMetrics(statuses),
        highlights: statuses.map(formatHighlight),
        warnings: buildWarnings(statuses),
        suggestedQueries: [
          "Refresh all cache",
          "Clear courses cache",
          "List courses",
          "List categories",
        ],
      },
    });
  };
}

function summarizeStatuses(statuses: CacheStatus[]): string {
  return statuses.map((status) => {
    const memory = status.memory.loaded
      ? `loaded in memory with ${status.memory.count} item${status.memory.count === 1 ? "" : "s"}`
      : "not loaded in memory";
    const disk = status.disk.exists
      ? `${status.disk.status} on disk${formatTtl(status)}`
      : "missing on disk";
    return `${titleCase(status.target)} cache is ${memory} and ${disk}.`;
  }).join(" ");
}

function formatHighlight(status: CacheStatus): string {
  const diskCount = status.disk.count === null
    ? "unknown disk count"
    : `${status.disk.count} disk item${status.disk.count === 1 ? "" : "s"}`;
  return `${status.target}: memory ${status.memory.loaded ? status.memory.count : "empty"}, disk ${status.disk.status}, ${diskCount}`;
}

function formatTtl(status: CacheStatus): string {
  if (status.disk.ttlRemainingMinutes === null) return "";
  if (status.disk.ttlRemainingMinutes < 0) {
    return `, expired ${Math.abs(status.disk.ttlRemainingMinutes)} min ago`;
  }
  return `, ${status.disk.ttlRemainingMinutes} min remaining`;
}

function buildMetrics(statuses: CacheStatus[]): Record<string, string | number | boolean | null> {
  const metrics: Record<string, string | number | boolean | null> = {};
  for (const status of statuses) {
    metrics[`${status.target}_memory_loaded`] = status.memory.loaded;
    metrics[`${status.target}_memory_count`] = status.memory.count;
    metrics[`${status.target}_disk_status`] = status.disk.status;
    metrics[`${status.target}_disk_count`] = status.disk.count;
    metrics[`${status.target}_disk_bytes`] = status.disk.bytes;
    metrics[`${status.target}_ttl_remaining_minutes`] = status.disk.ttlRemainingMinutes;
  }
  return metrics;
}

function buildWarnings(statuses: CacheStatus[]): string[] | undefined {
  const warnings = statuses.flatMap((status) => {
    if (status.disk.status === "fresh") return [];
    if (status.disk.status === "missing") return [`${status.target} cache file is missing.`];
    if (status.disk.status === "wrong_site") return [`${status.target} cache belongs to a different Moodle URL.`];
    if (status.disk.status === "wrong_version") return [`${status.target} cache version is incompatible.`];
    if (status.disk.status === "corrupt") return [`${status.target} cache file is corrupt: ${status.disk.error ?? "unknown error"}`];
    if (status.disk.status === "stale") return [`${status.target} cache is stale.`];
    return [`${status.target} cache file is invalid.`];
  });
  return warnings.length ? warnings : undefined;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
