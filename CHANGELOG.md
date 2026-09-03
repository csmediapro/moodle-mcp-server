# Changelog

All notable changes to this project will be documented here.

The project is pre-1.0. Breaking changes may happen while the public API, config shape, and plugin contract settle.

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
