import assert from "node:assert/strict";
import test from "node:test";
import { extractSilo, filterUsersBySilo, matchesSilo } from "../dist/tools/silo.js";
import { createHandler as createGetUserHandler } from "../dist/tools/get-user.js";
import { createHandler as createListCourseUsersHandler } from "../dist/tools/list-course-users.js";
import { createHandler as createListUserCoursesHandler } from "../dist/tools/list-user-courses.js";
import { createHandler as createSearchUsersHandler } from "../dist/tools/search-users.js";

const schoolA = "Example Academy";
const schoolB = "Different School";

function caps(functions) {
  return {
    functions: new Set(functions),
    probedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function user(id, fullname, school) {
  return {
    id,
    username: fullname.toLowerCase().replace(/\s+/g, "."),
    firstname: fullname.split(" ")[0],
    lastname: fullname.split(" ").slice(1).join(" ") || "Learner",
    fullname,
    email: `${id}@example.com`,
    department: "Training",
    institution: "Test Org",
    idnumber: String(id),
    lastaccess: 0,
    lastcourseaccess: 0,
    firstaccess: 0,
    city: "",
    country: "US",
    groups: [],
    roles: [{ roleid: 5, shortname: "student" }],
    ...(school === undefined
      ? {}
      : { customfields: [{ type: "text", value: school, name: "School", shortname: "school" }] }),
  };
}

test("silo helpers match raw and normalized custom fields with strict default", () => {
  const silo = extractSilo({ _silo: { field: "school", value: schoolA } });

  assert.deepEqual(silo, { field: "school", value: schoolA });
  assert.equal(matchesSilo([{ shortname: "school", value: schoolA }], silo), true);
  assert.equal(matchesSilo({ school: schoolA }, silo), true);
  assert.equal(matchesSilo([{ shortname: "school", value: schoolB }], silo), false);
  assert.equal(matchesSilo(undefined, silo), false);
  assert.equal(matchesSilo(undefined, silo, false), true);
  assert.deepEqual(
    filterUsersBySilo([
      { id: 1, customfields: { school: schoolA } },
      { id: 2, customfields: { school: schoolB } },
      { id: 3 },
    ], silo).map((item) => item.id),
    [1],
  );
});

test("search_users applies _silo and excludes users without matching custom fields", async () => {
  const handler = createSearchUsersHandler({
    async call({ wsfunction }) {
      assert.equal(wsfunction, "core_user_get_users");
      return { users: [user(1, "Ada Learner", schoolA), user(2, "Bea Learner", schoolB), user(3, "Cal Learner")] };
    },
  }, caps(["core_user_get_users"]));

  const result = await handler({ lastname: "Learner", _silo: { field: "school", value: schoolA } });

  assert.equal(result.ok, true);
  assert.equal(result.meta.entity, "user");
  assert.equal(result.data.record.id, 1);
});

test("get_user hides an out-of-silo exact lookup as not found", async () => {
  const handler = createGetUserHandler({
    async call({ wsfunction }) {
      assert.equal(wsfunction, "core_user_get_users_by_field");
      return [user(2, "Bea Learner", schoolB)];
    },
  }, caps(["core_user_get_users_by_field"]));

  const result = await handler({ id: 2, _silo: { field: "school", value: schoolA } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "user_not_found");
  assert.equal(result.meta.resultCount, 0);
});

test("list_course_users filters before pagination when _silo is present", async () => {
  const calls = [];
  const handler = createListCourseUsersHandler({
    async call({ wsfunction, params }) {
      calls.push({ wsfunction, params });
      assert.equal(wsfunction, "core_enrol_get_enrolled_users");
      return [user(2, "Bea Learner", schoolB), user(1, "Ada Learner", schoolA), user(4, "Dana Learner", schoolA)];
    },
  }, caps(["core_enrol_get_enrolled_users"]));

  const result = await handler({
    courseid: 42,
    limit: 1,
    offset: 1,
    _silo: { field: "school", value: schoolA },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.rows.map((row) => row.id), [4]);
  assert.equal(result.data.pagination.total, 2);
  assert.equal(result.data.pagination.hasMore, false);
  assert.deepEqual(Object.keys(calls[0].params), ["courseid"]);
});

test("list_user_courses preflights _silo and does not fetch courses for mismatched users", async () => {
  const calls = [];
  const handler = createListUserCoursesHandler({
    getBaseUrl: () => "https://moodle.example.test",
    async call({ wsfunction }) {
      calls.push(wsfunction);
      if (wsfunction === "core_user_get_users_by_field") {
        return [user(2, "Bea Learner", schoolB)];
      }
      throw new Error(`Unexpected call: ${wsfunction}`);
    },
  }, caps(["core_enrol_get_users_courses", "core_user_get_users_by_field"]));

  const result = await handler({ userid: 2, _silo: { field: "school", value: schoolA } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "user_not_found");
  assert.deepEqual(calls, ["core_user_get_users_by_field"]);
});
