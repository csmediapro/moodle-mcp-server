import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MoodleClient } from "../dist/moodle/client.js";
import { logToolCall, initLogging } from "../dist/logging/index.js";
import { sanitizeArgsForTelemetry } from "../dist/server/factory.js";

/**
 * R0 security tests — token transport, log permissions/retention,
 * and telemetry sanitization. Companion to
 * security-review-2026-11-23.md findings 7, 10, 16.3.
 */

// ---------------------------------------------------------------------------
// Finding 7 — Moodle token travels in the POST body, never the URL
// ---------------------------------------------------------------------------

function lastRequest(scope) {
  assert.ok(scope.calls.length >= 1, "no fetch calls were made");
  return scope.calls[scope.calls.length - 1];
}

test("moodle client sends wstoken in the POST body, not the URL", async () => {
  const scope = { calls: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    scope.calls.push({ input: String(input), init });
    return {
      ok: true,
      json: async () => ({ somekey: [] }),
    };
  };
  try {
    const client = new MoodleClient("https://moodle.example.edu/", "SECRET-TOKEN-123");
    const result = await client.call({
      wsfunction: "core_course_get_courses",
      params: { courseid: 5 },
      responseKey: "somekey",
    });

    const req = lastRequest(scope);
    assert.equal(req.input, "https://moodle.example.edu/webservice/rest/server.php",
      "URL must contain no query string at all");
    assert.ok(!req.input.includes("SECRET-TOKEN-123"), "token must not appear in URL");
    assert.equal(req.init.method, "POST");
    assert.equal(req.init.headers["Content-Type"], "application/x-www-form-urlencoded");

    const body = req.init.body;
    assert.ok(body.includes("wstoken=SECRET-TOKEN-123"), "token must be in the form body");
    assert.ok(body.includes("wsfunction=core_course_get_courses"));
    assert.ok(body.includes("moodlewsrestformat=json"));
    assert.ok(body.includes("courseid=5"));
    assert.deepEqual(result, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("moodle client refuses redirects so tokens cannot be forwarded to another origin", async () => {
  const scope = { calls: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    scope.calls.push({ input: String(input), init });
    return { ok: true, json: async () => ({}) };
  };
  try {
    const client = new MoodleClient("https://moodle.example.edu", "tok");
    await client.call({ wsfunction: "core_webservice_get_site_info" });
    const req = lastRequest(scope);
    assert.equal(req.init.redirect, "error",
      "fetch must refuse to follow redirects that would re-send the token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("moodle client error messages never include the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden" });
  try {
    const client = new MoodleClient("https://moodle.example.edu", "SECRET-TOKEN-123");
    await assert.rejects(
      () => client.call({ wsfunction: "core_course_get_courses" }),
      (err) => {
        assert.ok(!err.message.includes("SECRET-TOKEN-123"),
          "error message must not leak the token");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Finding 16.3 — tool-call log permissions and retention
// ---------------------------------------------------------------------------

test("tool-call log directory is created 0700 and log file 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-log-perm-"));
  const logPath = join(dir, "sub", "tool-calls.jsonl");
  try {
    initLogging({
      logging: { level: "info", toolCallLog: logPath },
    } );
    logToolCall({
      tool: "list_users",
      args: { email: "learner@example.edu" },
      success: true,
      durationMs: 12,
    });

    const fileMode = statSync(logPath).mode & 0o777;
    assert.equal(fileMode, 0o600, `log file must be 0600, got ${fileMode.toString(8)}`);

    const dirMode = statSync(join(dir, "sub")).mode & 0o777;
    assert.equal(dirMode, 0o700, `log directory must be 0700, got ${dirMode.toString(8)}`);

    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(line.event, "tool_call");
    assert.equal(line.tool, "list_users");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool-call log retention trims oldest lines at the size cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-log-retention-"));
  const logPath = join(dir, "tool-calls.jsonl");
  try {
    initLogging({
      logging: { level: "info", toolCallLog: logPath, toolCallLogMaxBytes: 700 },
    });

    // Each entry is ~150 bytes; 700-byte cap holds ~4 lines.
    for (let i = 0; i < 10; i++) {
      logToolCall({
        tool: `tool_${i}`,
        args: { seq: i },
        success: true,
        durationMs: 5,
      });
    }

    const content = readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    assert.ok(lines.length <= 6,
      `retention must keep the log bounded, got ${lines.length} lines`);

    // Oldest lines are dropped, newest retained, and no line is corrupt.
    const first = JSON.parse(lines[0]);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.ok(first.args.seq > 0, "oldest entries are trimmed first");
    assert.equal(last.args.seq, 9, "newest entry is retained");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention keeps whole JSONL lines only — no partial leading line", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-log-partial-"));
  const logPath = join(dir, "tool-calls.jsonl");
  try {
    // Pre-existing file with a corrupted partial first line (simulated
    // prior crash) followed by enough valid lines to exceed the cap,
    // so retention actually runs on the trim path.
    writeFileSync(logPath, '{"event":"tool_call","trunca', { mode: 0o600 });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        logPath,
        JSON.stringify({ event: "tool_call", tool: `t${i}`, args: { seq: i } }) + "\n",
        { flag: "a" }
      );
    }

    initLogging({
      logging: { level: "info", toolCallLog: logPath, toolCallLogMaxBytes: 300 },
    });
    logToolCall({ tool: "new_call", args: { seq: 99 }, success: true, durationMs: 1 });

    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
    assert.ok(lines.length >= 1, "at least the new entry must be retained");
    for (const line of lines) {
      assert.ok(line.startsWith("{"), "no partial/corrupt leading line survives retention");
      JSON.parse(line); // every retained line must be valid JSON
    }
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.args.seq, 99, "newest entry is present after trim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 10 — telemetry sanitization covers names and generic-key emails
// ---------------------------------------------------------------------------

test("sanitize masks email-labeled keys (regression of prior behavior)", () => {
  const out = sanitizeArgsForTelemetry({ email: "hung.le@example.edu" });
  assert.equal(out.email, "h***@example.edu");
});

test("sanitize masks person-name keys", () => {
  const out = sanitizeArgsForTelemetry({
    name: "Hung Le",
    firstname: "Hung",
    lastname: "Le",
    fullname: "Hung Le",
    username: "hle",
    displayname: "Hung Le",
  });
  assert.equal(out.name, "***");
  assert.equal(out.firstname, "***");
  assert.equal(out.lastname, "***");
  assert.equal(out.fullname, "***");
  assert.equal(out.username, "***");
  assert.equal(out.displayname, "***");
});

test("sanitize masks email-shaped values under generic keys", () => {
  const out = sanitizeArgsForTelemetry({
    query: "hung.le@example.edu",
    filter: "contact hung.le@example.edu please",
  });
  // Exact email value under a generic key is masked
  assert.equal(out.query, "h***@example.edu");
  // Free text: the embedded email is masked in place, surrounding text
  // is preserved so the query shape remains useful for debugging.
  assert.equal(out.filter, "contact h***@example.edu please");
  assert.ok(!JSON.stringify(out).includes("hung.le"), "raw local part never appears");
});

test("sanitize preserves non-identifying values and structure", () => {
  const out = sanitizeArgsForTelemetry({
    courseid: 1583,
    school: "Lackawanna",
    active: true,
    nested: { cohortValue: "Net+", limit: 100 },
    list: [{ email: "a@b.edu" }, { course: "Pharmacy" }],
  });
  assert.equal(out.courseid, 1583);
  assert.equal(out.school, "Lackawanna");
  assert.equal(out.active, true);
  assert.equal(out.nested.cohortValue, "Net+");
  assert.equal(out.list[0].email, "***", "1-char local part is fully masked (original conservative behavior)");
  assert.equal(out.list[1].course, "Pharmacy");
});

test("_silo authorization constraints are retained for scope debugging", () => {
  const out = sanitizeArgsForTelemetry({
    _silo: { field: "school", value: "Lackawanna" },
    courseid: 5,
  });
  assert.deepEqual(out._silo, { field: "school", value: "Lackawanna" });
});
