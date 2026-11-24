# Changelog

All notable changes to this project will be documented here.

The project is pre-1.0. Breaking changes may happen while the public API, config shape, and plugin contract settle.

## 1.0.0 - 2026-11-24

Security hardening release. The 1.0 version marks the transition from the building phase to the certification-grade phase across the AQL stack; the security contract is now enforceable and tested.

- **Moodle token transport (finding 7):** `wstoken` now travels in a form-encoded POST body instead of the URL query string, so the token can no longer leak into server, proxy, or analytics access logs. Requests refuse redirects (`redirect: "error"`) so a redirect cannot forward credentials to an unintended origin. Error messages never include the token.
- **Tool-call log permissions and retention (findings 10, 16.3):** the log directory is created `0700` and the log file `0600` so partially-masked learner search values are not world-readable on shared hosts. A configurable size cap (`logging.toolCallLogMaxBytes`, default 20 MiB, env `LOGGING_TOOL_CALL_LOG_MAX_BYTES`) trims the oldest complete lines; corrupt or partial leading lines from a prior crash are dropped rather than retained as unparseable telemetry.
- **Telemetry sanitization (finding 10):** masking now covers person-name keys (`name`, `firstname`, `lastname`, `fullname`, `username`, `displayname`) and email-shaped values under any key — including free text containing an embedded email — not just email-labeled keys. `_silo` authorization constraints are retained for scope debugging.
- **Security test suite:** 10 new tests (`test/security-r0.test.mjs`) covering token-in-body, redirect refusal, token-free error messages, log permissions, retention trimming, partial-line recovery, and sanitization coverage. Suite total: 61.

Companion to the Agent Edge security review (`security-review-2026-11-23.md`). No tool, schema, or plugin contract changes; fully additive. Agent Edge v1.0.0 (R1) will pin this release.

## 0.1.8 - 2026-11-06

- **Plugin interaction protocol:** Formalized declarative interaction execution modes, including `direct_tool`, for server-declared actions that a capable client can execute without model interpretation.
- **Cell-bound row actions:** Added an optional `placement` hint for binding a row action to a named table cell. Clients that do not support cell placement retain a compatible ordinary row-action rendering.
- **Public SDK and documentation:** Exported the new interaction types through `moodle-mcp-server-aql/sdk`, documented the protocol and fallback behavior, and added contract coverage.

## 0.1.7 - 2026-10-01

- **Course search regex hardening**: Escaped search terms before word-boundary scoring so regex metacharacters like `*` and `()` cannot break `search_courses_by_name` or plugin callers that use the SDK course search helper.
- **Empty search guard**: Blank or whitespace-only course searches now return no matches instead of scoring every cached course.
- **Regression coverage**: Added course-search tests for blank, wildcard, and regex-special course-name input.

## 0.1.6 - 2026-09-26

- **list_courses visibility filter**: Added `visible` boolean parameter so callers can list hidden courses (`visible=false`) or visible courses (`visible=true`) without post-filtering. Raised `limit` max from 200 to 1500 for admin cleanup workflows. Updated tool description and suggested queries.
- **list_courses category mismatch guard fix**: Fixed an unreachable `category_id_name_mismatch` error branch — `categoryname` resolution was overwriting `resolvedCategoryId` before the mismatch check, making the guard impossible to trigger. Now preserves the original `categoryid` for comparison.
- **get_course response contract**: Now returns `data.presentation: "compact_card"` for record responses, matching `get_user` and single-result `search_users`. Structured `course_not_found` error replaces plain string error. Cleaned up description to match actual returned fields and removed unused import.
- **Server response audit**: Documented full tool-by-tool response contract audit at `docs/SERVER_RESPONSE_AUDIT.md`. Server response contract work is frozen; artifact/UX iteration moves to Agent Edge.
- **Test coverage**: Added `packages/server/test/list-courses.test.mjs` (7 tests: default listing, hidden filter, category+visibility composition, category name resolution, 3 structured error branches). Added `packages/server/test/server-response-contract.test.mjs` (4 tests: get_course compact_card, get_course not-found, schema tool table responses, update_user_field_schema inline status record, valid data.kind guard).

## 0.1.5 - 2026-09-25

- **Tool schema compatibility**: Fixed Zod-to-JSON-Schema conversion so tools built with either Zod 3 or Zod 4 advertise complete input schemas to LLM providers.
- **Plugin SDK**: Exported `z` from `moodle-mcp-server-aql/sdk` so plugins can build schemas through the MCP Core Server SDK path.
- **Regression coverage**: Added tests proving progress-report-style schemas advertise required parameters, nested objects, optional/defaulted fields, and descriptions for both Zod 3 and Zod 4.

## 0.1.4 - 2026-09-09

- **SDK packaging fix**: Include `dist/plugins/sdk.*` in the npm package so the public `moodle-mcp-server-aql/sdk` export added in 0.1.3 resolves from the published tarball.
- **Release metadata**: Align server package lock metadata and MCP Registry `server.json` on version 0.1.4.
- **Repository cleanup**: Removed stale `user-directory` core tests and README wording after the plugin moved out of the OSS server package.

## 0.1.3 - 2026-09-08

- **Plugin SDK**: Exported a public SDK module at `moodle-mcp-server-aql/sdk` re-exporting response builders, silo helpers, capability checking, error class, cache access, course search, user field schema helpers, and all plugin contract types. Plugins should import from the SDK instead of reaching into server internals.
- **PluginContext expanded**: Added `cache: PluginContextCache` to `PluginContext` with `getCourses()` and `getCategories()` so plugins can access the core's cache without direct imports.
- **Package exports**: Added `"./sdk"` export path to `package.json` with proper `import` and `types` fields for TypeScript NodeNext resolution.
- **user-directory plugin moved**: The `user-directory` plugin is no longer bundled with the core. It now lives in `mcp-agent-edge` as a premium plugin. Standalone users who need user directory functionality can install it separately or write their own using the Plugin SDK.
- Updated plugin documentation ([Creating Plugins](docs/plugins/CREATING-PLUGINS.md), [Plugin Contract](docs/plugins/CONTRACT.md)) with SDK usage and expanded context.

## 0.1.2 - 2026-09-03

- Added optional internal `_silo` filtering for user-facing tools, intended for agent-edge sub-user boundaries.
- Kept standalone behavior unchanged when `_silo` is absent.
- Filtered course-user and cached directory results by Moodle custom profile fields before returning data.
- Added direct user lookup preflight checks so out-of-silo user IDs are reported as not found.
- Added regression tests for silo helpers, search/list filtering, cached directory filtering, and guessed-ID blocking.

## 0.1.0 - Unreleased

- Initial open-source preparation for the stdio `moodle-mcp-server` core.
- Core Moodle query tools for courses, users, assignments, categories, site info, cache management, and user field schema management.
- Runtime plugin contract for optional tool packages.
- Reference client for local testing with MCP-compatible model providers.
