import assert from "node:assert/strict";
import test from "node:test";
import { createHandler as createSearchUsersHandler } from "../dist/tools/search-users.js";
import { createHandler as createGetUserHandler } from "../dist/tools/get-user.js";

const bailey = {
  id: 14733,
  username: "bailey.wallace",
  firstname: "Bailey",
  lastname: "Wallace",
  fullname: "Bailey Wallace",
  email: "bailey@example.com",
  department: "Training",
  suspended: false,
  confirmed: true,
  customfields: [
    { type: "text", value: "Example Academy", name: "School", shortname: "school" },
    { type: "checkbox", value: "1", name: "Live Online Student", shortname: "liveonlinestudent" },
  ],
};

const alex = {
  id: 1194,
  username: "alex.wallace",
  firstname: "Alex",
  lastname: "Wallace",
  fullname: "Alex Wallace",
  email: "alex@example.com",
  suspended: false,
  confirmed: true,
};

class MockSearchClient {
  constructor(users) {
    this.users = users;
  }

  async call({ wsfunction }) {
    assert.equal(wsfunction, "core_user_get_users");
    return { users: this.users };
  }
}

class MockLookupClient {
  constructor(users) {
    this.users = users;
  }

  async call({ wsfunction, params }) {
    assert.equal(wsfunction, "core_user_get_users_by_field");
    assert.ok(params.field);
    assert.ok(params["values[0]"]);
    return this.users;
  }
}

function searchCapabilities() {
  return {
    functions: new Set(["core_user_get_users"]),
    probedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function lookupCapabilities() {
  return {
    functions: new Set(["core_user_get_users_by_field"]),
    probedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

test("search_users returns a compact record and primary user entity for one match", async () => {
  const handler = createSearchUsersHandler(new MockSearchClient([bailey]), searchCapabilities());

  const result = await handler({ email: "bailey@example.com" });

  assert.equal(result.ok, true);
  assert.equal(result.meta.entity, "user");
  assert.equal(result.meta.entityId, 14733);
  assert.equal(result.data.kind, "record");
  assert.equal(result.data.presentation, "compact_card");
  assert.equal(result.data.record.id, 14733);
  assert.equal(result.context.metrics.id, 14733);
  assert.deepEqual(result.context.primaryEntity, { type: "user", id: 14733 });
  assert.equal(result.context.entities.length, 1);
  assert.equal(result.context.entities[0].id, 14733);
  assert.deepEqual(
    result.context.entities[0].actions.find((action) => action.tool === "get_user_progress_report")?.args,
    { userid: 14733 },
  );
});

test("search_users returns table rows, entities, and structured row actions for multiple matches", async () => {
  const handler = createSearchUsersHandler(new MockSearchClient([bailey, alex]), searchCapabilities());

  const result = await handler({ lastname: "Wallace" });

  assert.equal(result.ok, true);
  assert.equal(result.meta.entity, "user_directory");
  assert.equal(result.data.kind, "table");
  assert.equal(result.data.presentation, "table");
  assert.equal(result.data.rows.length, 2);
  assert.equal(result.data.rows[0].id, 14733);
  assert.equal(result.data.rows[1].id, 1194);
  assert.deepEqual(result.context.entities.map((entity) => entity.id), [14733, 1194]);
  assert.equal(result.context.primaryEntity, undefined);
  assert.equal(result.interactions.mode, "row_actions");

  const progressAction = result.interactions.rowActions.find(
    (action) => action.tool === "get_user_progress_report",
  );
  assert.deepEqual(progressAction.argsFromRow, { userid: "id" });
});

test("get_user defaults to compact card and exposes structured user actions", async () => {
  const handler = createGetUserHandler(new MockLookupClient([bailey]), lookupCapabilities());

  const result = await handler({ id: 14733 });

  assert.equal(result.ok, true);
  assert.equal(result.data.kind, "record");
  assert.equal(result.data.presentation, "compact_card");
  assert.ok(Array.isArray(result.data.columns));
  assert.deepEqual(result.context.primaryEntity, { type: "user", id: 14733 });
  assert.deepEqual(
    result.context.entities[0].actions.find((action) => action.tool === "list_user_courses")?.args,
    { userid: 14733 },
  );
});

test("get_user supports full card presentation for explicit detail views", async () => {
  const handler = createGetUserHandler(new MockLookupClient([bailey]), lookupCapabilities());

  const result = await handler({ id: 14733, presentation: "full" });

  assert.equal(result.ok, true);
  assert.equal(result.data.kind, "record");
  assert.equal(result.data.presentation, "full_card");
  assert.equal(result.data.columns, undefined);
  assert.equal(result.data.record.id, 14733);
  assert.equal(result.data.record.customfields, undefined);
  assert.equal(result.data.record.school, "Example Academy");
  assert.equal(result.data.record.liveonlinestudent, true);
  assert.equal(result.context.metrics.customFieldCount, 2);
  assert.ok(result.context.fields.includes("customfields.school"));
});
