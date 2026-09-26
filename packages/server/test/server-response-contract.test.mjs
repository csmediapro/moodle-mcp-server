import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHandler as createGetCourseHandler } from "../dist/tools/get-course.js";
import {
  createGetSchemaHandler,
  createRefreshSchemaHandler,
  createReorderSchemaHandler,
  createUpdateSchemaHandler,
} from "../dist/tools/user-schema.js";

const VALID_KINDS = new Set(["table", "record", "list", "none"]);

function assertValidKind(result) {
  assert.ok(result.data, "tool result should include data");
  assert.ok(VALID_KINDS.has(result.data.kind), `unexpected data.kind: ${result.data.kind}`);
}

function tempSchemaPath() {
  const dir = mkdtempSync(join(tmpdir(), "moodle-mcp-schema-contract-"));
  return {
    dir,
    path: join(dir, "user-field-schema.json"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeSchema(path, overrides = {}) {
  const schema = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    siteUrl: "https://learn.example.test",
    moodleVersion: "4.5",
    userFields: {
      id: {
        name: "User ID",
        type: "number",
        source: "standard",
        display: true,
        filterable: false,
        displayOrder: 0,
      },
      fullname: {
        name: "Full Name",
        type: "string",
        source: "standard",
        display: true,
        filterable: true,
        displayOrder: 1,
      },
      email: {
        name: "Email",
        type: "string",
        source: "standard",
        display: true,
        filterable: true,
        displayOrder: 2,
      },
      department: {
        name: "Department",
        type: "string",
        source: "standard",
        display: false,
        filterable: true,
      },
    },
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(schema, null, 2), "utf8");
  return schema;
}

class MockCourseClient {
  async call({ wsfunction, params, responseKey }) {
    assert.equal(wsfunction, "core_course_get_courses_by_field");
    assert.equal(params.field, "id");
    assert.equal(params.value, 1583);
    assert.equal(responseKey, "courses");
    return [
      {
        id: 1583,
        fullname: "Pharmacy Technician with eBooks v3",
        shortname: "PHARM-V3",
        summary: "<p>Course summary</p>",
        categoryid: 20,
        format: "topics",
        visible: 1,
        enablecompletion: 1,
      },
    ];
  }
}

class MockMissingCourseClient {
  async call({ wsfunction, params, responseKey }) {
    assert.equal(wsfunction, "core_course_get_courses_by_field");
    assert.equal(params.field, "id");
    assert.equal(responseKey, "courses");
    return [];
  }
}

class MockRefreshClient {
  async call({ wsfunction }) {
    if (wsfunction === "core_webservice_get_site_info") {
      return {
        userid: 7,
        siteurl: "https://learn.example.test",
        version: "4.5",
        release: "4.5",
      };
    }
    if (wsfunction === "core_user_get_users_by_field") {
      return [
        {
          id: 7,
          fullname: "Service User",
          email: "service@example.test",
          customfields: [
            { shortname: "school", name: "School", type: "text", value: "Example Academy" },
          ],
        },
      ];
    }
    if (wsfunction === "core_course_get_courses_by_field") {
      return [];
    }
    if (wsfunction === "core_user_get_users") {
      return { users: [] };
    }
    throw new Error(`Unhandled Moodle function: ${wsfunction}`);
  }
}

test("get_course returns an explicit compact-card record response", async () => {
  const handler = createGetCourseHandler(new MockCourseClient(), { functions: new Set(), probedAt: new Date("2026-01-01") });

  const result = await handler({ courseid: 1583 });

  assert.equal(result.ok, true);
  assert.equal(result.meta.tool, "get_course");
  assert.equal(result.meta.entity, "course");
  assert.equal(result.meta.entityId, 1583);
  assert.equal(result.data.kind, "record");
  assert.equal(result.data.presentation, "compact_card");
  assert.equal(result.data.record.id, 1583);
  assert.equal(result.data.record.enablecompletion, true);
  assertValidKind(result);
});

test("get_course returns structured not-found errors", async () => {
  const handler = createGetCourseHandler(new MockMissingCourseClient(), { functions: new Set(), probedAt: new Date("2026-01-01") });

  const result = await handler({ courseid: 999999 });

  assert.equal(result.ok, false);
  assert.equal(result.meta.tool, "get_course");
  assert.equal(result.meta.entity, "course");
  assert.equal(result.meta.entityId, 999999);
  assert.equal(result.data.kind, "none");
  assert.equal(result.error.kind, "not_found");
  assert.equal(result.error.code, "course_not_found");
  assertValidKind(result);
});

test("schema read, refresh, and reorder tools return table artifacts for the canonical schema view", async () => {
  const schemaFile = tempSchemaPath();
  const previousPath = process.env.MOODLE_USER_FIELD_SCHEMA_PATH;
  process.env.MOODLE_USER_FIELD_SCHEMA_PATH = schemaFile.path;

  try {
    writeSchema(schemaFile.path);

    const getResult = await createGetSchemaHandler()({});
    assert.equal(getResult.ok, true);
    assert.equal(getResult.meta.tool, "get_user_field_schema");
    assert.equal(getResult.data.kind, "table");
    assert.ok(Array.isArray(getResult.data.columns));
    assert.ok(Array.isArray(getResult.data.rows));
    assertValidKind(getResult);

    const reorderResult = await createReorderSchemaHandler()({ field: "email", position: "start" });
    assert.equal(reorderResult.ok, true);
    assert.equal(reorderResult.meta.tool, "reorder_user_field_schema");
    assert.equal(reorderResult.data.kind, "table");
    assert.ok(Array.isArray(reorderResult.data.rows));
    assertValidKind(reorderResult);

    const refreshResult = await createRefreshSchemaHandler(new MockRefreshClient())({ force: false });
    assert.equal(refreshResult.ok, true);
    assert.equal(refreshResult.meta.tool, "refresh_user_field_schema");
    assert.equal(refreshResult.data.kind, "table");
    assert.ok(Array.isArray(refreshResult.data.rows));
    assertValidKind(refreshResult);
  } finally {
    if (previousPath === undefined) {
      delete process.env.MOODLE_USER_FIELD_SCHEMA_PATH;
    } else {
      process.env.MOODLE_USER_FIELD_SCHEMA_PATH = previousPath;
    }
    schemaFile.cleanup();
  }
});

test("update_user_field_schema remains a structured inline status record, not an artifact-tab card", async () => {
  const schemaFile = tempSchemaPath();
  const previousPath = process.env.MOODLE_USER_FIELD_SCHEMA_PATH;
  process.env.MOODLE_USER_FIELD_SCHEMA_PATH = schemaFile.path;

  try {
    writeSchema(schemaFile.path);

    const changed = await createUpdateSchemaHandler()({ field: "department", display: true });
    assert.equal(changed.ok, true);
    assert.equal(changed.meta.tool, "update_user_field_schema");
    assert.equal(changed.data.kind, "record");
    assert.equal(changed.data.presentation, undefined);
    assert.deepEqual(changed.data.record.changedFields, ["department"]);
    assert.ok(Array.isArray(changed.data.record.currentTableColumns));
    assertValidKind(changed);

    const unchanged = await createUpdateSchemaHandler()({ field: "department", display: true });
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.data.kind, "record");
    assert.equal(unchanged.data.presentation, undefined);
    assert.equal(typeof unchanged.data.record.message, "string");
    assertValidKind(unchanged);
  } finally {
    if (previousPath === undefined) {
      delete process.env.MOODLE_USER_FIELD_SCHEMA_PATH;
    } else {
      process.env.MOODLE_USER_FIELD_SCHEMA_PATH = previousPath;
    }
    schemaFile.cleanup();
  }
});
