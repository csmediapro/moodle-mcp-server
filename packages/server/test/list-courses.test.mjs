import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearCache } from "../dist/tools/cache.js";
import { createHandler } from "../dist/tools/list-courses.js";

const categories = [
  { id: 10, name: "Healthcare", description: "", parent: 0, depth: 1, path: "/10" },
  { id: 20, name: "Retired Courses", description: "", parent: 0, depth: 1, path: "/20" },
  { id: 30, name: "Duplicate", description: "", parent: 0, depth: 1, path: "/30" },
  { id: 31, name: "Duplicate", description: "", parent: 0, depth: 1, path: "/31" },
];;

const courses = [
  { id: 101, fullname: "Visible Healthcare", shortname: "VIS-H", categoryid: 10, visible: 1 },
  { id: 102, fullname: "Hidden Healthcare", shortname: "HID-H", categoryid: 10, visible: 0 },
  { id: 201, fullname: "Retired Visible", shortname: "RET-V", categoryid: 20, visible: 1 },
];

class MockCatalogClient {
  constructor(site) {
    this.site = site;
  }

  getBaseUrl() {
    return this.site;
  }

  async call({ wsfunction }) {
    if (wsfunction === "core_course_get_courses_by_field") return courses;
    if (wsfunction === "core_course_get_categories") return categories;
    throw new Error(`Unhandled Moodle function: ${wsfunction}`);
  }
}

function tempCacheDir() {
  return mkdtempSync(join(tmpdir(), "moodle-mcp-list-courses-"));
}

async function withCatalog(testName, fn) {
  const dir = tempCacheDir();
  const previousCacheDir = process.env.MOODLE_CACHE_DIR;
  process.env.MOODLE_CACHE_DIR = dir;

  try {
    await clearCache("all");
    const handler = createHandler(
      new MockCatalogClient(`https://learn.example.test/${encodeURIComponent(testName)}`),
      { functions: new Set(), probedAt: new Date("2026-01-01T00:00:00.000Z") },
    );
    await fn(handler);
  } finally {
    await clearCache("all");
    if (previousCacheDir === undefined) {
      delete process.env.MOODLE_CACHE_DIR;
    } else {
      process.env.MOODLE_CACHE_DIR = previousCacheDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("list_courses returns all available courses by default, including hidden rows", async () => {
  await withCatalog("default", async (handler) => {
    const result = await handler({ limit: 1500 });

    assert.equal(result.ok, true);
    assert.equal(result.data.kind, "table");
    assert.equal(result.data.rows.length, 3);
    assert.deepEqual(result.data.rows.map((row) => row.id), [101, 102, 201]);
    assert.equal(result.data.pagination.limit, 1500);
    assert.equal(result.data.pagination.total, 3);
    assert.equal(result.context.metrics.total, 3);
    assert.equal(result.context.metrics.visible, 2);
    assert.equal(result.context.metrics.hidden, 1);
    assert.equal(result.context.metrics.visibilityFilter, null);
  });
});

test("list_courses filters hidden courses with visible=false", async () => {
  await withCatalog("hidden", async (handler) => {
    const result = await handler({ visible: false, limit: 1500 });

    assert.equal(result.ok, true);
    assert.equal(result.data.kind, "table");
    assert.deepEqual(result.data.rows.map((row) => row.id), [102]);
    assert.equal(result.data.rows[0].visible, false);
    assert.equal(result.context.metrics.total, 1);
    assert.equal(result.context.metrics.visible, 0);
    assert.equal(result.context.metrics.hidden, 1);
    assert.equal(result.context.metrics.visibilityFilter, false);
    assert.match(result.context.summary, /hidden courses/);
  });
});

test("list_courses composes category and visibility filters", async () => {
  await withCatalog("category-visible", async (handler) => {
    const result = await handler({ categoryid: 10, visible: true, limit: 1500 });

    assert.equal(result.ok, true);
    assert.equal(result.data.kind, "table");
    assert.deepEqual(result.data.rows.map((row) => row.id), [101]);
    assert.equal(result.data.rows[0].categoryname, "Healthcare");
    assert.equal(result.context.metrics.categoryid, 10);
    assert.equal(result.context.metrics.visibilityFilter, true);
    assert.equal(result.data.pagination.total, 1);
  });
});

test("list_courses resolves categoryname to categoryid", async () => {
  await withCatalog("category-name", async (handler) => {
    const result = await handler({ categoryname: "Healthcare", limit: 1500 });

    assert.equal(result.ok, true);
    assert.equal(result.data.kind, "table");
    assert.deepEqual(result.data.rows.map((row) => row.id), [101, 102]);
    assert.equal(result.context.metrics.categoryid, 10);
    assert.match(result.context.summary, /Healthcare/);
  });
});

test("list_courses returns structured error for unknown categoryname", async () => {
  await withCatalog("category-not-found", async (handler) => {
    const result = await handler({ categoryname: "Nonexistent", limit: 1500 });

    assert.equal(result.ok, false);
    assert.equal(result.data.kind, "none");
    assert.equal(result.error.kind, "not_found");
    assert.equal(result.error.code, "category_name_not_found");
    assert.equal(result.meta.resultCount, 0);
  });
});

test("list_courses returns structured error for ambiguous categoryname", async () => {
  await withCatalog("category-ambiguous", async (handler) => {
    const result = await handler({ categoryname: "Duplicate", limit: 1500 });

    assert.equal(result.ok, false);
    assert.equal(result.data.kind, "none");
    assert.equal(result.error.kind, "validation");
    assert.equal(result.error.code, "category_name_ambiguous");
    assert.ok(result.context.highlights.length >= 2);
  });
});

test("list_courses returns structured error for categoryid/categoryname mismatch", async () => {
  await withCatalog("category-mismatch", async (handler) => {
    const result = await handler({ categoryid: 10, categoryname: "Retired Courses", limit: 1500 });

    assert.equal(result.ok, false);
    assert.equal(result.data.kind, "none");
    assert.equal(result.error.kind, "validation");
    assert.equal(result.error.code, "category_id_name_mismatch");
  });
});
