import assert from "node:assert/strict";
import test from "node:test";

import {
  createHandler,
  emptyAgentRuntimeConfig,
  name,
} from "../dist/tools/get-agent-runtime-config.js";

test("get_agent_runtime_config returns merged declarative agent rules", async () => {
  const config = emptyAgentRuntimeConfig();
  config.promptRules.push("Use the registered test tool.");
  config.intentRoutes.push({
    id: "test-route",
    match: "test",
    tool: "test_tool",
    args: { limit: 10 },
  });
  config.toolRewrites.push({
    id: "test-rewrite",
    whenTool: "wrong_tool",
    match: "test",
    tool: "test_tool",
  });
  config.continuationActions.push({
    tool: "test_tool",
    keywords: ["test"],
  });
  config.plugins.push({
    id: "com.example.test",
    name: "Test Plugin",
    version: "1.0.0",
  });

  const handler = createHandler(() => config);
  const result = await handler({});

  assert.equal(result.promptRules[0], "Use the registered test tool.");
  assert.equal(result.intentRoutes[0].id, "test-route");
  assert.equal(result.toolRewrites[0].whenTool, "wrong_tool");
  assert.equal(result.continuationActions[0].tool, "test_tool");
  assert.equal(result.plugins[0].id, "com.example.test");
});

test("get_agent_runtime_config rejects unexpected arguments", async () => {
  const handler = createHandler(() => emptyAgentRuntimeConfig());

  const result = await handler({ unexpected: true });

  assert.equal(Array.isArray(result.promptRules), true);
  assert.equal(name, "get_agent_runtime_config");
});
