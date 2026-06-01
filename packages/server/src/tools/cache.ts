import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logging/index.js";
import { MoodleClient } from "../moodle/client.js";

/**
 * Shared cache for categories and courses.
 *
 * Both list-categories.ts and list-courses.ts import from here to avoid a
 * circular dependency. Caches are hydrated from memory first, then from a
 * server-side file cache, and finally from Moodle when no valid cache exists.
 */

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

export type CacheTarget = "courses" | "categories";
export type CacheTargetOrAll = CacheTarget | "all";
type CacheSource = "memory" | "disk" | "moodle";
type DiskCacheStatus = "missing" | "fresh" | "stale" | "wrong_site" | "wrong_version" | "invalid" | "corrupt";

type PersistentCacheEntry<T> = {
  version: string;
  target: CacheTarget;
  moodleUrl: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  data: T;
};

export type CacheRefreshResult = {
  target: CacheTarget;
  source: "moodle";
  count: number;
};

export type CacheClearResult = {
  target: CacheTarget;
  memoryCleared: boolean;
  persistentCleared: boolean;
};

export type CacheStatus = {
  target: CacheTarget;
  memory: {
    loaded: boolean;
    count: number;
  };
  disk: {
    exists: boolean;
    valid: boolean;
    status: DiskCacheStatus;
    path?: string;
    bytes: number | null;
    count: number | null;
    version: string | null;
    moodleUrl: string | null;
    moodleUrlMatches: boolean | null;
    createdAt: string | null;
    updatedAt: string | null;
    expiresAt: string | null;
    ageMinutes: number | null;
    ttlRemainingMinutes: number | null;
    error: string | null;
  };
};

const CACHE_VERSION = "1.0";
const CACHE_MAX_AGE_HOURS = 24;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let categoryCache: Category[] | null = null;
let courseCache: Course[] | null = null;

function cacheDir(): string {
  return process.env.MOODLE_CACHE_DIR || resolve(__dirname, "..", "..", "data", "cache");
}

function cacheFilePath(target: CacheTarget): string {
  return resolve(cacheDir(), `${target}.json`);
}

function targetsFor(target: CacheTargetOrAll): CacheTarget[] {
  return target === "all" ? ["courses", "categories"] : [target];
}

function moodleUrlFor(client: MoodleClient): string {
  return client.getBaseUrl();
}

function expiresAt(): string {
  return new Date(Date.now() + CACHE_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
}

function isFresh(entry: PersistentCacheEntry<unknown>): boolean {
  return new Date(entry.expiresAt).getTime() > Date.now();
}

function minutesBetween(start: number, end: number): number {
  return Math.round((end - start) / 60000);
}

function isValidEntry<T>(
  entry: unknown,
  target: CacheTarget,
  moodleUrl: string,
): entry is PersistentCacheEntry<T> {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<PersistentCacheEntry<T>>;
  return (
    candidate.version === CACHE_VERSION &&
    candidate.target === target &&
    candidate.moodleUrl === moodleUrl &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.expiresAt === "string" &&
    Array.isArray(candidate.data) &&
    isFresh(candidate as PersistentCacheEntry<T>)
  );
}

function readPersistentCache<T extends unknown[]>(target: CacheTarget, moodleUrl: string): T | null {
  const path = cacheFilePath(target);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isValidEntry<T>(parsed, target, moodleUrl)) {
      logger.info("Ignoring stale or incompatible cache file", {
        event: "cache_file_ignored",
        target,
        path,
      });
      return null;
    }
    logger.info("Loaded cache from disk", {
      event: "cache_disk_hit",
      target,
      path,
      count: parsed.data.length,
    });
    return parsed.data;
  } catch (error) {
    logger.warn("Failed to load cache file; falling back to Moodle", {
      event: "cache_file_load_failed",
      target,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function writePersistentCache<T>(target: CacheTarget, moodleUrl: string, data: T): void {
  const dir = cacheDir();
  const path = cacheFilePath(target);
  const now = new Date().toISOString();
  const existing = readExistingEntryCreatedAt(path);
  const entry: PersistentCacheEntry<T> = {
    version: CACHE_VERSION,
    target,
    moodleUrl,
    createdAt: existing ?? now,
    updatedAt: now,
    expiresAt: expiresAt(),
    data,
  };

  mkdirSync(dir, { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(entry, null, 2), "utf-8");
  renameSync(tempPath, path);
  logger.info("Saved cache to disk", {
    event: "cache_file_saved",
    target,
    path,
    count: Array.isArray(data) ? data.length : undefined,
  });
}

function readExistingEntryCreatedAt(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed.createdAt === "string" ? parsed.createdAt : null;
  } catch {
    return null;
  }
}

function deletePersistentCache(target: CacheTarget): boolean {
  const path = cacheFilePath(target);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  logger.info("Deleted cache file", {
    event: "cache_file_deleted",
    target,
    path,
  });
  return true;
}

function inspectPersistentCache(target: CacheTarget, moodleUrl: string): CacheStatus["disk"] {
  const path = cacheFilePath(target);
  if (!existsSync(path)) {
    return {
      exists: false,
      valid: false,
      status: "missing",
      bytes: null,
      count: null,
      version: null,
      moodleUrl: null,
      moodleUrlMatches: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      ageMinutes: null,
      ttlRemainingMinutes: null,
      error: null,
    };
  }

  const bytes = statSync(path).size;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<PersistentCacheEntry<unknown[]>>;
    const now = Date.now();
    const updatedAtMs = typeof parsed.updatedAt === "string" ? new Date(parsed.updatedAt).getTime() : NaN;
    const expiresAtMs = typeof parsed.expiresAt === "string" ? new Date(parsed.expiresAt).getTime() : NaN;
    const moodleUrlMatches = parsed.moodleUrl === moodleUrl;
    const hasShape =
      parsed.target === target &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string" &&
      typeof parsed.expiresAt === "string" &&
      Array.isArray(parsed.data);

    let status: DiskCacheStatus = "fresh";
    if (parsed.version !== CACHE_VERSION) {
      status = "wrong_version";
    } else if (!moodleUrlMatches) {
      status = "wrong_site";
    } else if (!hasShape || Number.isNaN(expiresAtMs)) {
      status = "invalid";
    } else if (expiresAtMs <= now) {
      status = "stale";
    }

    return {
      exists: true,
      valid: status === "fresh",
      status,
      bytes,
      count: Array.isArray(parsed.data) ? parsed.data.length : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      moodleUrl: typeof parsed.moodleUrl === "string" ? parsed.moodleUrl : null,
      moodleUrlMatches,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      ageMinutes: Number.isNaN(updatedAtMs) ? null : minutesBetween(updatedAtMs, now),
      ttlRemainingMinutes: Number.isNaN(expiresAtMs) ? null : minutesBetween(now, expiresAtMs),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      status: "corrupt",
      bytes,
      count: null,
      version: null,
      moodleUrl: null,
      moodleUrlMatches: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      ageMinutes: null,
      ttlRemainingMinutes: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchCategories(client: MoodleClient): Promise<Category[]> {
  return client.call<Category[]>({
    wsfunction: "core_course_get_categories",
    // No criteria: return all categories the token can see. Passing empty
    // criteria strings triggers a search permission check for restricted tokens.
  });
}

async function fetchCourses(client: MoodleClient): Promise<Course[]> {
  return client.call<Course[]>({
    wsfunction: "core_course_get_courses_by_field",
    responseKey: "courses",
  });
}

async function getOrLoad<T>(
  target: CacheTarget,
  memoryValue: T[] | null,
  setMemory: (data: T[]) => void,
  client: MoodleClient,
  fetcher: (client: MoodleClient) => Promise<T[]>,
): Promise<T[]> {
  if (memoryValue) {
    logger.info(`Using ${memoryValue.length} ${target} from memory cache`, {
      event: "cache_load_memory",
      target,
      count: memoryValue.length,
    });
    logger.debug("Loaded cache from memory", {
      event: "cache_memory_hit",
      target,
      count: memoryValue.length,
    });
    return memoryValue;
  }

  const moodleUrl = moodleUrlFor(client);
  const persisted = readPersistentCache<T[]>(target, moodleUrl);
  if (persisted) {
    logger.info(`Loaded ${persisted.length} ${target} from disk cache`, {
      event: "cache_load_disk",
      target,
      count: persisted.length,
    });
    setMemory(persisted);
    return persisted;
  }

  logger.info(`Fetching ${target} from Moodle...`, {
    event: "cache_fetch_moodle_start",
    target,
  });
  const data = await fetcher(client);
  logger.info(`Fetched ${data.length} ${target} from Moodle`, {
    event: "cache_fetch_moodle_complete",
    target,
    count: data.length,
  });
  setMemory(data);
  writePersistentCache(target, moodleUrl, data);
  logger.info("Loaded cache from Moodle", {
    event: "cache_moodle_fetch",
    target,
    count: data.length,
  });
  return data;
}

export async function getCategories(client: MoodleClient): Promise<Category[]> {
  return getOrLoad("categories", categoryCache, (data) => {
    categoryCache = data;
  }, client, fetchCategories);
}

export async function getCourses(client: MoodleClient): Promise<Course[]> {
  return getOrLoad("courses", courseCache, (data) => {
    courseCache = data;
  }, client, fetchCourses);
}

export async function clearCache(
  target: CacheTargetOrAll = "all",
): Promise<CacheClearResult[]> {
  return targetsFor(target).map((cacheTarget) => {
    let memoryCleared = false;
    if (cacheTarget === "courses") {
      memoryCleared = courseCache !== null;
      courseCache = null;
    } else {
      memoryCleared = categoryCache !== null;
      categoryCache = null;
    }

    return {
      target: cacheTarget,
      memoryCleared,
      persistentCleared: deletePersistentCache(cacheTarget),
    };
  });
}

export async function refreshCache(
  client: MoodleClient,
  target: CacheTargetOrAll = "all",
): Promise<CacheRefreshResult[]> {
  const moodleUrl = moodleUrlFor(client);

  return Promise.all(targetsFor(target).map(async (cacheTarget) => {
    if (cacheTarget === "courses") {
      const data = await fetchCourses(client);
      courseCache = data;
      writePersistentCache(cacheTarget, moodleUrl, data);
      return { target: cacheTarget, source: "moodle", count: data.length };
    }

    const data = await fetchCategories(client);
    categoryCache = data;
    writePersistentCache(cacheTarget, moodleUrl, data);
    return { target: cacheTarget, source: "moodle", count: data.length };
  }));
}

export async function warmupCaches(client: MoodleClient): Promise<void> {
  logger.info("Warming up course/category cache from Moodle...", {
    event: "cache_warmup_start",
  });
  await Promise.all([getCategories(client), getCourses(client)]);
  logger.info("Cache warmup completed!", {
    event: "cache_warmup_complete",
  });
}

export function getCacheState(): Array<{
  target: CacheTarget;
  source: Exclude<CacheSource, "moodle"> | "empty";
  count: number;
}> {
  return [{
    target: "courses",
    source: courseCache ? "memory" : "empty",
    count: courseCache?.length ?? 0,
  }, {
    target: "categories",
    source: categoryCache ? "memory" : "empty",
    count: categoryCache?.length ?? 0,
  }];
}

export function getCacheStatus(
  client: MoodleClient,
  target: CacheTargetOrAll = "all",
): CacheStatus[] {
  const moodleUrl = moodleUrlFor(client);
  return targetsFor(target).map((cacheTarget) => {
    const memoryData = cacheTarget === "courses" ? courseCache : categoryCache;
    return {
      target: cacheTarget,
      memory: {
        loaded: memoryData !== null,
        count: memoryData?.length ?? 0,
      },
      disk: inspectPersistentCache(cacheTarget, moodleUrl),
    };
  });
}
