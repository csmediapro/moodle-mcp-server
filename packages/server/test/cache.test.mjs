import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadCacheModule(cacheDir) {
  process.env.MOODLE_CACHE_DIR = cacheDir;
  return import(`../dist/tools/cache.js?test=${Date.now()}-${Math.random()}`);
}

function makeClient({
  site = "https://learn.example.test",
  courses = [],
  categories = [],
  failOnCall = false,
} = {}) {
  return {
    calls: [],
    courses,
    categories,
    failOnCall,
    getBaseUrl() {
      return site;
    },
    async call(request) {
      this.calls.push(request.wsfunction);
      if (this.failOnCall) {
        throw new Error(`Unexpected Moodle call: ${request.wsfunction}`);
      }
      if (request.wsfunction === "core_course_get_courses_by_field") return this.courses;
      if (request.wsfunction === "core_course_get_categories") return this.categories;
      throw new Error(`Unhandled Moodle function: ${request.wsfunction}`);
    },
  };
}

function tempCacheDir() {
  return mkdtempSync(join(tmpdir(), "moodle-mcp-cache-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("getCourses caches in memory and refreshCache forces a Moodle refetch", async () => {
  const dir = tempCacheDir();
  try {
    const cache = await loadCacheModule(dir);
    const client = makeClient({
      courses: [{ id: 1, fullname: "Old", shortname: "OLD", visible: 1 }],
    });

    const first = await cache.getCourses(client);
    const second = await cache.getCourses(client);
    assert.equal(first[0].fullname, "Old");
    assert.equal(second[0].fullname, "Old");
    assert.deepEqual(client.calls, ["core_course_get_courses_by_field"]);

    client.courses = [{ id: 2, fullname: "New", shortname: "NEW", visible: 1 }];
    const refresh = await cache.refreshCache(client, "courses");
    const third = await cache.getCourses(client);

    assert.equal(refresh[0].count, 1);
    assert.equal(third[0].fullname, "New");
    assert.deepEqual(client.calls, [
      "core_course_get_courses_by_field",
      "core_course_get_courses_by_field",
    ]);
  } finally {
    cleanup(dir);
  }
});

test("getCourses hydrates from disk cache for a fresh module instance", async () => {
  const dir = tempCacheDir();
  try {
    const writer = await loadCacheModule(dir);
    const writeClient = makeClient({
      courses: [{ id: 10, fullname: "Persisted", shortname: "PERSIST", visible: 1 }],
    });
    await writer.getCourses(writeClient);
    assert.equal(writeClient.calls.length, 1);
    assert.ok(existsSync(join(dir, "courses.json")));

    const reader = await loadCacheModule(dir);
    const readClient = makeClient({ failOnCall: true });
    const courses = await reader.getCourses(readClient);

    assert.equal(courses[0].fullname, "Persisted");
    assert.equal(readClient.calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("stale disk cache is ignored and replaced from Moodle", async () => {
  const dir = tempCacheDir();
  try {
    const writer = await loadCacheModule(dir);
    await writer.getCourses(makeClient({
      courses: [{ id: 20, fullname: "Stale", shortname: "STALE", visible: 1 }],
    }));

    const cachePath = join(dir, "courses.json");
    const entry = JSON.parse(readFileSync(cachePath, "utf-8"));
    entry.expiresAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(cachePath, JSON.stringify(entry, null, 2), "utf-8");

    const reader = await loadCacheModule(dir);
    const client = makeClient({
      courses: [{ id: 21, fullname: "Fresh", shortname: "FRESH", visible: 1 }],
    });
    const courses = await reader.getCourses(client);

    assert.equal(courses[0].fullname, "Fresh");
    assert.deepEqual(client.calls, ["core_course_get_courses_by_field"]);
  } finally {
    cleanup(dir);
  }
});

test("corrupt disk cache falls back to Moodle", async () => {
  const dir = tempCacheDir();
  try {
    writeFileSync(join(dir, "courses.json"), "{ nope", "utf-8");

    const cache = await loadCacheModule(dir);
    const client = makeClient({
      courses: [{ id: 30, fullname: "Recovered", shortname: "RECOVER", visible: 1 }],
    });
    const courses = await cache.getCourses(client);

    assert.equal(courses[0].fullname, "Recovered");
    assert.deepEqual(client.calls, ["core_course_get_courses_by_field"]);
  } finally {
    cleanup(dir);
  }
});

test("clearCache clears memory and deletes only requested files", async () => {
  const dir = tempCacheDir();
  try {
    const cache = await loadCacheModule(dir);
    await cache.refreshCache(makeClient({
      courses: [{ id: 40, fullname: "Course", shortname: "COURSE", visible: 1 }],
      categories: [{ id: 1, name: "Category", description: "", parent: 0, depth: 1, path: "/1" }],
    }), "all");

    assert.ok(existsSync(join(dir, "courses.json")));
    assert.ok(existsSync(join(dir, "categories.json")));

    const result = await cache.clearCache("courses");

    assert.equal(result.length, 1);
    assert.equal(result[0].target, "courses");
    assert.equal(result[0].memoryCleared, true);
    assert.equal(result[0].persistentCleared, true);
    assert.equal(existsSync(join(dir, "courses.json")), false);
    assert.ok(existsSync(join(dir, "categories.json")));
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus reports missing cache files", async () => {
  const dir = tempCacheDir();
  try {
    const cache = await loadCacheModule(dir);
    const statuses = cache.getCacheStatus(makeClient(), "all");

    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].memory.loaded, false);
    assert.equal(statuses[0].disk.exists, false);
    assert.equal(statuses[0].disk.status, "missing");
    assert.equal(statuses[1].disk.status, "missing");
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus reports memory-loaded and fresh disk cache", async () => {
  const dir = tempCacheDir();
  try {
    const cache = await loadCacheModule(dir);
    const client = makeClient({
      courses: [{ id: 50, fullname: "Status", shortname: "STATUS", visible: 1 }],
    });
    await cache.getCourses(client);

    const [status] = cache.getCacheStatus(client, "courses");

    assert.equal(status.target, "courses");
    assert.equal(status.memory.loaded, true);
    assert.equal(status.memory.count, 1);
    assert.equal(status.disk.exists, true);
    assert.equal(status.disk.valid, true);
    assert.equal(status.disk.status, "fresh");
    assert.equal(status.disk.count, 1);
    assert.equal(status.disk.moodleUrlMatches, true);
    assert.equal(typeof status.disk.bytes, "number");
    assert.equal(typeof status.disk.ttlRemainingMinutes, "number");
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus reports fresh disk cache when memory is empty", async () => {
  const dir = tempCacheDir();
  try {
    const writer = await loadCacheModule(dir);
    const client = makeClient({
      courses: [{ id: 60, fullname: "Disk", shortname: "DISK", visible: 1 }],
    });
    await writer.getCourses(client);

    const reader = await loadCacheModule(dir);
    const [status] = reader.getCacheStatus(client, "courses");

    assert.equal(status.memory.loaded, false);
    assert.equal(status.memory.count, 0);
    assert.equal(status.disk.status, "fresh");
    assert.equal(status.disk.count, 1);
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus reports stale disk cache", async () => {
  const dir = tempCacheDir();
  try {
    const writer = await loadCacheModule(dir);
    const client = makeClient({
      courses: [{ id: 70, fullname: "Expired", shortname: "EXPIRED", visible: 1 }],
    });
    await writer.getCourses(client);

    const cachePath = join(dir, "courses.json");
    const entry = JSON.parse(readFileSync(cachePath, "utf-8"));
    entry.expiresAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(cachePath, JSON.stringify(entry, null, 2), "utf-8");

    const reader = await loadCacheModule(dir);
    const [status] = reader.getCacheStatus(client, "courses");

    assert.equal(status.disk.valid, false);
    assert.equal(status.disk.status, "stale");
    assert.ok(status.disk.ttlRemainingMinutes < 0);
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus reports wrong Moodle URL", async () => {
  const dir = tempCacheDir();
  try {
    const writer = await loadCacheModule(dir);
    await writer.getCourses(makeClient({
      site: "https://one.example.test",
      courses: [{ id: 80, fullname: "Site One", shortname: "ONE", visible: 1 }],
    }));

    const reader = await loadCacheModule(dir);
    const [status] = reader.getCacheStatus(makeClient({
      site: "https://two.example.test",
    }), "courses");

    assert.equal(status.disk.valid, false);
    assert.equal(status.disk.status, "wrong_site");
    assert.equal(status.disk.moodleUrlMatches, false);
    assert.equal(status.disk.moodleUrl, "https://one.example.test");
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus reports corrupt cache files", async () => {
  const dir = tempCacheDir();
  try {
    writeFileSync(join(dir, "courses.json"), "{ nope", "utf-8");

    const cache = await loadCacheModule(dir);
    const [status] = cache.getCacheStatus(makeClient(), "courses");

    assert.equal(status.disk.exists, true);
    assert.equal(status.disk.valid, false);
    assert.equal(status.disk.status, "corrupt");
    assert.equal(typeof status.disk.error, "string");
  } finally {
    cleanup(dir);
  }
});

test("getCacheStatus filters by target", async () => {
  const dir = tempCacheDir();
  try {
    const cache = await loadCacheModule(dir);

    const courses = cache.getCacheStatus(makeClient(), "courses");
    const categories = cache.getCacheStatus(makeClient(), "categories");

    assert.deepEqual(courses.map((status) => status.target), ["courses"]);
    assert.deepEqual(categories.map((status) => status.target), ["categories"]);
  } finally {
    cleanup(dir);
  }
});
