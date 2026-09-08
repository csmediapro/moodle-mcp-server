# Changelog

All notable changes to this project will be documented here.

The project is pre-1.0. Breaking changes may happen while the public API, config shape, and plugin contract settle.

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
