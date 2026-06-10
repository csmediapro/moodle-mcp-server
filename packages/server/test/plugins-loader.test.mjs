import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadPlugins } from "../dist/plugins/loader.js";

function baseContext(overrides = {}) {
  const logs = [];
  const events = [];

  return {
    ctx: {
      moodleClient: {},
      capabilities: { functions: new Set(), probedAt: new Date("2026-01-01T00:00:00.000Z") },
      log: (level, message, data) => logs.push({ level, message, data }),
      config: { serverName: "Test Server", serverVersion: "0.1.0" },
      emitStatus: (event) => events.push(event),
      ...overrides,
    },
    logs,
    events,
  };
}

async function writePlugin(dir, source) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), source, "utf8");
}

async function tempPluginDir(name) {
  return mkdtemp(join(tmpdir(), `moodle-loader-${name}-`));
}

function pluginSource({
  id = "com.example.test",
  requiredCapabilities = [],
  initialize = "",
  agent = "",
} = {}) {
  return `
    export const plugin = {
      manifest: {
        id: ${JSON.stringify(id)},
        name: "Test Plugin",
        version: "1.0.0",
        apiVersion: "1",
        description: "Test plugin",
        requiredCapabilities: ${JSON.stringify(requiredCapabilities)},
        tools: ["test_plugin_tool"]
      },
      ${agent}
      ${initialize}
      tools: [{
        name: "test_plugin_tool",
        description: "Test tool",
        inputSchema: { type: "object", properties: {} },
        createHandler: (ctx) => async () => ({ server: ctx.config.serverName })
      }]
    };
    export default plugin;
  `;
}

test("loadPlugins loads a valid standalone package directory", async () => {
  const dir = await tempPluginDir("valid");
  await writePlugin(dir, pluginSource());

  const { ctx, events } = baseContext();
  const loaded = await loadPlugins([{ path: dir }], ctx);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.id, "com.example.test");
  assert.equal(loaded[0].tools[0].name, "test_plugin_tool");
  assert.equal(events.find((event) => event.type === "plugin_loaded")?.pluginId, "com.example.test");
});

test("loadPlugins preserves optional plugin agent registration", async () => {
  const dir = await tempPluginDir("agent");
  await writePlugin(dir, pluginSource({
    agent: `
      agent: {
        promptRules: ["Use test_plugin_tool for test prompts."],
        intentRoutes: [{
          id: "test-route",
          match: "test",
          tool: "test_plugin_tool",
          args: { ok: true }
        }],
        toolRewrites: [{
          id: "test-rewrite",
          whenTool: "old_tool",
          match: "test",
          tool: "test_plugin_tool"
        }],
        continuationActions: [{
          tool: "test_plugin_tool",
          keywords: ["test"]
        }]
      },
    `,
  }));

  const { ctx } = baseContext();
  const loaded = await loadPlugins([{ path: dir }], ctx);

  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].agent.promptRules, ["Use test_plugin_tool for test prompts."]);
  assert.equal(loaded[0].agent.intentRoutes[0].id, "test-route");
  assert.equal(loaded[0].agent.toolRewrites[0].id, "test-rewrite");
  assert.equal(loaded[0].agent.continuationActions[0].tool, "test_plugin_tool");
});

test("loadPlugins loads the checked-in hello plugin example", async () => {
  const examplePath = resolve(process.cwd(), "../../examples/plugins/hello-plugin");

  const { ctx } = baseContext();
  const loaded = await loadPlugins([{ path: examplePath }], ctx);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.id, "com.example.hello");

  const handler = loaded[0].tools[0].createHandler({
    moodleClient: ctx.moodleClient,
    capabilities: ctx.capabilities,
    log: ctx.log,
    config: ctx.config,
  });

  assert.deepEqual(await handler({ name: "Moodle" }), {
    ok: true,
    greeting: "Hello, Moodle",
    server: "Test Server",
  });
});

test("loadPlugins loads the checked-in course completion report plugin", async () => {
  const pluginPath = resolve(process.cwd(), "dist/plugins/get-course-completion-report");

  const { ctx } = baseContext({
    capabilities: {
      functions: new Set([
        "core_course_get_courses_by_field",
        "core_enrol_get_enrolled_users",
        "core_completion_get_course_completion_status",
      ]),
      probedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const loaded = await loadPlugins([{ path: pluginPath }], ctx);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.id, "get-course-completion-report");
  assert.equal(loaded[0].tools[0].name, "get_course_completion_report");
});

test("loadPlugins loads the checked-in user progress report plugin", async () => {
  const pluginPath = resolve(process.cwd(), "dist/plugins/get-user-progress-report");

  const { ctx } = baseContext({
    capabilities: {
      functions: new Set([
        "core_user_get_users_by_field",
        "core_enrol_get_users_courses",
        "gradereport_user_get_grade_items",
        "core_completion_get_activities_completion_status",
      ]),
      probedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const loaded = await loadPlugins([{ path: pluginPath }], ctx);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.id, "get-user-progress-report");
  assert.equal(loaded[0].tools[0].name, "get_user_progress_report");
  assert.equal(loaded[0].agent.continuationActions[0].tool, "get_user_progress_report");
});

test("loadPlugins loads the checked-in user directory plugin", async () => {
  const pluginPath = resolve(process.cwd(), "dist/plugins/user-directory");

  const { ctx } = baseContext({
    capabilities: {
      functions: new Set([
        "core_user_get_users",
      ]),
      probedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const loaded = await loadPlugins([{ path: pluginPath }], ctx);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.id, "user-directory");
  assert.equal(loaded[0].tools[0].name, "list_users");
  assert.ok(loaded[0].agent.intentRoutes.some((route) => route.tool === "list_users"));
  assert.ok(loaded[0].agent.toolRewrites.some((rewrite) => rewrite.tool === "list_users"));
});

test("course completion report plugin builds a joined report", async () => {
  const pluginPath = resolve(process.cwd(), "dist/plugins/get-course-completion-report");
  const calls = [];
  const moodleClient = {
    async call(call) {
      calls.push(call.wsfunction);

      if (call.wsfunction === "core_course_get_courses_by_field") {
        return [
          {
            id: 22,
            fullname: "New Online Student Orientation",
            shortname: "Orientation",
            enablecompletion: 1,
          },
        ];
      }

      if (call.wsfunction === "core_enrol_get_enrolled_users") {
        return [
          {
            id: 101,
            username: "complete",
            firstname: "Complete",
            lastname: "Learner",
            fullname: "Complete Learner",
            email: "complete@example.test",
            lastaccess: 1760000000,
            lastcourseaccess: 1760000100,
            roles: [{ shortname: "student" }],
          },
          {
            id: 102,
            username: "progress",
            firstname: "Progress",
            lastname: "Learner",
            fullname: "Progress Learner",
            email: "progress@example.test",
            lastaccess: 1760000200,
            lastcourseaccess: 1760000300,
            roles: [{ shortname: "student" }],
          },
        ];
      }

      if (call.wsfunction === "core_completion_get_course_completion_status") {
        if (call.params.userid === 101) {
          return {
            completionstatus: {
              completed: 1,
              aggregation: 1,
              completions: [
                { complete: 1, timecompleted: 1760000400 },
                { complete: 1, timecompleted: 1760000500 },
              ],
            },
          };
        }

        return {
          completionstatus: {
            completed: 0,
            aggregation: 1,
            completions: [
              { complete: 1, timecompleted: 1760000600 },
              { complete: 0 },
            ],
          },
        };
      }

      throw new Error(`Unexpected Moodle call: ${call.wsfunction}`);
    },
  };
  const { ctx } = baseContext({
    moodleClient,
    capabilities: {
      functions: new Set([
        "core_course_get_courses_by_field",
        "core_enrol_get_enrolled_users",
        "core_completion_get_course_completion_status",
      ]),
      probedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const loaded = await loadPlugins([{ path: pluginPath }], ctx);
  const handler = loaded[0].tools[0].createHandler({
    moodleClient,
    capabilities: ctx.capabilities,
    log: ctx.log,
    config: ctx.config,
  });

  const result = await handler({ courseid: 22, limit: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.meta.tool, "get_course_completion_report");
  assert.equal(result.context.metrics.completed, 1);
  assert.equal(result.context.metrics.in_progress, 1);
  assert.equal(result.context.metrics.completion_pct, 50);
  assert.equal(result.data.rows.length, 2);
  assert.equal(result.data.rows[0].status, "Completed");
  assert.equal(result.data.rows[1].status, "In Progress");
  assert.deepEqual(calls, [
    "core_course_get_courses_by_field",
    "core_enrol_get_enrolled_users",
    "core_completion_get_course_completion_status",
    "core_completion_get_course_completion_status",
  ]);
});

test("loadPlugins skips plugins with missing required capabilities", async () => {
  const dir = await tempPluginDir("missing-cap");
  await writePlugin(dir, pluginSource({ requiredCapabilities: ["gradereport_user_get_grade_items"] }));

  const { ctx, events } = baseContext();
  const loaded = await loadPlugins([{ path: dir }], ctx);

  assert.equal(loaded.length, 0);
  assert.equal(events.find((event) => event.reasonCode === "capability_missing")?.pluginId, "com.example.test");
});

test("loadPlugins skips plugins whose initialize hook fails", async () => {
  const dir = await tempPluginDir("init-fails");
  await writePlugin(
    dir,
    pluginSource({ initialize: "initialize: () => { throw new Error('nope'); }," }),
  );

  const { ctx, events } = baseContext();
  const loaded = await loadPlugins([{ path: dir }], ctx);

  assert.equal(loaded.length, 0);
  assert.equal(events.find((event) => event.reasonCode === "initialize_failed")?.pluginId, "com.example.test");
});
