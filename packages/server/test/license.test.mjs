import assert from "node:assert/strict";
import test from "node:test";

import { validateLicense } from "../dist/plugins/license.js";

test("validateLicense reports missing keys explicitly", () => {
  assert.deepEqual(validateLicense(), {
    status: "missing",
    reason: "No license key provided. Set MOODLE_PLUGIN_KEY or plugins.licenseKey in config.json.",
    featuresEnabled: [],
  });
});

test("validateLicense rejects malformed keys", () => {
  assert.equal(validateLicense("not-a-license").status, "invalid");
});

test("validateLicense accepts keys with a valid checksum", () => {
  assert.deepEqual(validateLicense("moodle-lic-6e20f716d2d213cd5fe9d5f5e216040a"), {
    status: "valid",
    tier: "premium",
    featuresEnabled: ["premium"],
    identity: "site:6e20f716",
  });
});
