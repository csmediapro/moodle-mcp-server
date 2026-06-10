import assert from "node:assert/strict";
import test from "node:test";

import { resolvePluginSearchPaths } from "../dist/config/loader.js";

test("resolvePluginSearchPaths resolves relative paths from the config file directory", () => {
  const paths = resolvePluginSearchPaths(
    [
      {
        path: "./dist/plugins/get-recent-activity",
      },
    ],
    "/srv/moodle-mcp/config/config.json",
  );

  assert.deepEqual(paths, [
    {
      path: "/srv/moodle-mcp/config/dist/plugins/get-recent-activity",
    },
  ]);
});

test("resolvePluginSearchPaths leaves absolute paths unchanged", () => {
  const paths = resolvePluginSearchPaths(
    [
      {
        path: "/opt/moodle-mcp/plugins",
      },
    ],
    "/srv/moodle-mcp/config/config.json",
  );

  assert.deepEqual(paths, [
    {
      path: "/opt/moodle-mcp/plugins",
    },
  ]);
});
