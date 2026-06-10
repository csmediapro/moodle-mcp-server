import assert from "node:assert/strict";
import test from "node:test";

import { createHandler } from "../dist/tools/get-capabilities.js";

test("get_capabilities groups registered tools by source", async () => {
  const handler = createHandler(() => [
    {
      name: "list_courses",
      description: "List courses",
      source: "core",
    },
    {
      name: "get_recent_activity",
      description: "Show recent course engagement",
      source: "plugin",
      plugin: {
        id: "get-recent-activity",
        name: "Recent Activity",
      },
    },
  ]);

  const result = await handler({});

  assert.equal(result.ok, true);
  assert.equal(result.meta.tool, "get_capabilities");
  assert.equal(result.data.kind, "table");
  assert.equal(result.data.presentation, "table");
  assert.equal(result.data.title, "Registered Tools");
  assert.equal(result.data.rows.length, 2);
  assert.equal(result.data.rows[0].name, "list_courses");
  assert.equal(result.data.rows[0].source, "core");
  assert.equal(result.data.rows[0].description, "List courses");
  assert.equal(result.data.rows[1].name, "get_recent_activity");
  assert.equal(result.data.rows[1].source, "plugin");
  assert.equal(result.data.rows[1].description, "Show recent course engagement");
  assert.equal(result.context.metrics.coreToolCount, 1);
  assert.equal(result.context.metrics.pluginToolCount, 1);
});
