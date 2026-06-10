import assert from "node:assert/strict";
import test from "node:test";

import { buildToolDefinitions } from "../dist/tools/index.js";

test("premium course completion report is not registered as a core tool", () => {
  const toolNames = buildToolDefinitions().map((tool) => tool.name);

  assert.equal(toolNames.includes("get_course_completion_report"), false);
});

test("premium user progress report is not registered as a core tool", () => {
  const toolNames = buildToolDefinitions().map((tool) => tool.name);

  assert.equal(toolNames.includes("get_user_progress_report"), false);
});
