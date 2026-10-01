# Changelog

All notable changes to this project will be documented here.

The project is pre-1.0. Breaking changes may happen while the public API, config shape, and plugin contract settle.

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
