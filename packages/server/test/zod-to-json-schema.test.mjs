import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { z as z4 } from "zod4";

import { zodToJsonSchema } from "../dist/utils/zod-to-json-schema.js";

function assertProgressReportSchema(json) {
  assert.equal(json.type, "object");
  assert.ok(json.properties.userid, "userid property should be advertised");
  assert.equal(json.properties.userid.type, "integer");
  assert.equal(json.properties.userid.description, "Exact Moodle user ID");
  assert.ok(json.properties.courseIdentifier, "optional courseIdentifier should be advertised");
  assert.equal(json.properties.courseIdentifier.type, "string");
  assert.ok(json.properties.includeEmptyCourses, "defaulted includeEmptyCourses should be advertised");
  assert.equal(json.properties.includeEmptyCourses.type, "boolean");
  assert.ok(json.properties.limitCourses, "defaulted limitCourses should be advertised");
  assert.equal(json.properties.limitCourses.type, "integer");
  assert.ok(json.properties._silo, "nested _silo object should be advertised");
  assert.deepEqual(json.properties._silo.required, ["field", "value"]);
  assert.deepEqual(json.required, ["userid"]);
}

function progressReportInputSchema(zod) {
  return zod.object({
    userid: zod.number().int().positive().describe("Exact Moodle user ID"),
    courseIdentifier: zod.string().optional().describe("Course ID (numeric) or course name (text) to filter by"),
    includeEmptyCourses: zod.boolean().optional().default(false).describe("Include courses with no grade items or completion data"),
    limitCourses: zod.number().int().min(1).max(100).optional().default(25).describe("Maximum number of courses to include in the report"),
    _silo: zod
      .object({
        field: zod.string(),
        value: zod.string(),
      })
      .optional()
      .describe("INTERNAL: Silo filter injected by agent-edge. Not for direct use."),
  });
}

test("zodToJsonSchema advertises required parameters for Zod 3 tool schemas", () => {
  const json = zodToJsonSchema(progressReportInputSchema(z));

  assertProgressReportSchema(json);
});

test("zodToJsonSchema advertises required parameters for Zod 4 plugin schemas", () => {
  const json = zodToJsonSchema(progressReportInputSchema(z4));

  assertProgressReportSchema(json);
});
