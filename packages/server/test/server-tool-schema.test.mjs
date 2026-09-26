import assert from "node:assert/strict";
import test from "node:test";
import { z as z4 } from "zod4";

import { createServer } from "../dist/server/factory.js";

test("createServer advertises Zod 4 plugin input schemas through tools/list", async () => {
  const plugin = {
    manifest: {
      id: "com.example.zod4",
      name: "Zod 4 Plugin",
      version: "1.0.0",
      apiVersion: "1",
      description: "Test plugin",
      requiredCapabilities: [],
      tools: ["zod4_progress_report"],
    },
    tools: [
      {
        name: "zod4_progress_report",
        description: "Build a progress report.",
        inputSchema: z4.object({
          userid: z4.number().int().positive().describe("Exact Moodle user ID"),
          includeEmptyCourses: z4.boolean().optional().default(false),
        }),
        createHandler: () => async () => ({ ok: true }),
      },
    ],
  };

  const { server } = createServer({
    name: "Test Server",
    version: "0.1.5",
    moodleClient: {},
    capabilities: { functions: new Set(), probedAt: new Date("2026-01-01T00:00:00.000Z") },
    authenticator: { authenticate: async () => ({}) },
    log: () => {},
    extraPlugins: [plugin],
  });

  const handler = server._requestHandlers.get("tools/list");
  assert.equal(typeof handler, "function");

  const result = await handler({ method: "tools/list", params: {} });
  const tool = result.tools.find((entry) => entry.name === "zod4_progress_report");

  assert.ok(tool, "plugin tool should be listed");
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.properties.userid.type, "integer");
  assert.equal(tool.inputSchema.properties.userid.description, "Exact Moodle user ID");
  assert.deepEqual(tool.inputSchema.required, ["userid"]);
});
