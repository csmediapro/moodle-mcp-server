# Server Response Audit

Date: 2026-09-26

Purpose: close out Moodle MCP Server response-contract work so Agent Edge can own artifact rendering, UX, prompt behavior, and follow-on iteration without needing more server churn.

This audit is intentionally server-only. It asks whether each Moodle MCP Server tool returns a stable structured response that a client can render without guessing.

## Contract Target

All visible tool handlers should return the `ToolResponse` shape from `packages/server/src/tools/response-types.ts`:

- `ok: true | false`
- optional `meta` with `tool`, `title`, `generatedAt`, `resultCount`, and entity metadata
- `data.kind` as one of `table`, `record`, `list`, `none`
- `context.summary`
- structured errors through `buildToolErrorResponse`

Artifact expectations for Agent Edge:

- `data.kind: "table"`: render a table artifact. Must include `columns` and `rows`; include `pagination` when partial.
- `data.kind: "record"` with `presentation: "compact_card" | "full_card"`: render a detail/card artifact. Must include `record`.
- `data.kind: "record"` without `presentation`: server should either add a presentation marker or the client should intentionally suppress it.
- `data.kind: "none"`: action/status/error/no-data result; no artifact by default.
- No handler should return non-contract kinds such as `empty`.

## Registered Core Tools

Registered in `packages/server/src/tools/index.ts`.

| Tool | Current server shape | Client artifact expectation | Server update needed | Test needed |
| --- | --- | --- | --- | --- |
| `list_courses` | `table` | Table artifact | ✅ Done: visibility filter, limit 1500, category name resolution, mismatch guard fixed, 7 tests. | Assert table columns/rows/pagination, visibility filtering, category+visibility composition, category name resolution, and all 3 structured error branches. |
| `get_course` | `record` with `compact_card` | Detail card | ✅ Done: `compact_card` presentation, structured not-found error. | Assert course details response is a record with presentation and record keys. |
| `list_course_users` | `table` | Table artifact | No contract change. | Assert success branches return table and no non-contract `data.kind`. |
| `list_assignments` | `table` | Table artifact | No contract change. | Assert empty and populated branches are tables. |
| `get_site_info` | `record` without `presentation` | Home tab / bootstrap only, no artifact | No server change if Agent Edge keeps suppressing this tool by name. Optional: document in client tests. | Assert client suppression, not server behavior. |
| `list_categories` | `table` on success, `none` on validation/no-result branches | Table or no artifact | No contract change. | Assert `none` branches are intentional and structured. |
| `get_user` | `record` with `compact_card` or `full_card` | Detail card | No contract change. High-value client test target. | Assert compact has `columns`, full has full record, errors use `buildToolErrorResponse`. |
| `list_user_courses` | `table` | Table artifact | No contract change. | Assert capability/not-found errors are structured. |
| `search_users` | `table`; single result becomes `record` with `compact_card` | Table or detail card | No contract change. High-value client test target. | Assert single-result card shape and multi-result table shape. |
| `search_courses_by_name` | `table` | Table artifact | No contract change. | Assert no-results and results are table responses; upstream errors structured. |
| `get_cache_status` | `table` | Table artifact only when explicitly requested | No contract change. | Assert table shape; Agent Edge should suppress system-tool auto-render unless requested. |
| `manage_cache` | `none` | No artifact | No contract change. | Assert action results are `none`. |

## Schema Tools

Registered separately in `packages/server/src/tools/index.ts` from `packages/server/src/tools/user-schema.ts`.

| Tool | Current server shape | Client artifact expectation | Server update needed | Test needed |
| --- | --- | --- | --- | --- |
| `get_user_field_schema` | `table` | Table artifact when requested | No contract change. | Assert missing-schema errors and schema table response. |
| `refresh_user_field_schema` | `table` | Table artifact when requested | No contract change. | Assert refresh success table and upstream errors. |
| `update_user_field_schema` | `record` status receipt | Inline chat status card; update existing schema artifact only if already open | No server contract change. Agent Edge should treat this as action/status output, not a new artifact tab. | Assert unchanged/updated record responses remain structured action receipts. |
| `reorder_user_field_schema` | `table` on success | Table artifact when requested | No contract change. | Assert success table and validation errors. |

## Non-Registered/Internal Tool

| Tool | Current server shape | Client artifact expectation | Server update needed | Test needed |
| --- | --- | --- | --- | --- |
| `get_agent_runtime_config` | raw internal config object | No visible artifact | No response-contract change. Keep internal. | Agent Edge should not expose as visible data artifact. |

## Concrete Server Punch List

Minimal server changes before freezing server-side artifact work:

1. ✅ `get_course` returns `presentation: "compact_card"` for record responses.
2. ✅ `list_courses` visibility filter (`visible=true/false`), limit max 1500, category name resolution, and mismatch guard fixed (was unreachable because `categoryname` resolution overwrote `categoryid`; now preserves original `categoryid` for the mismatch check).
3. ✅ `update_user_field_schema` remains a structured record status receipt — not promoted to an artifact-tab card by default.
   - It reports `schemaVersion`, `changedFields`, `currentTableColumns`, or a no-op message.
   - Agent Edge should render it inline in chat/tool-result UI.
   - If the canonical schema artifact tab is already open, Agent Edge may refresh/update that existing tab after the status result.
4. ✅ Contract tests covering:
   - table shape: `list_courses` (7 tests), `server-response-contract` schema tools
   - catalog filtering: `list_courses` default/all, hidden-only, visible-only/category-scoped, category name resolution
   - detail/card shape: `get_course` compact_card, not-found error
   - action/no-artifact shape: `update_user_field_schema` inline status record
   - schema tools: `get_user_field_schema`, `refresh_user_field_schema`, `reorder_user_field_schema` table responses
   - error shape: `category_name_not_found`, `category_name_ambiguous`, `category_id_name_mismatch`, `course_not_found`
5. ✅ Guard assertion that valid server `data.kind` values are only `table`, `record`, `list`, or `none` (in `server-response-contract.test.mjs`).

## Schema Artifact Tab Policy

The user field schema tools represent one current configuration surface, not a
history of reports. Agent Edge should maintain one canonical schema artifact
tab by default.

Recommended client behavior:

- `get_user_field_schema`: open or update the canonical `User Field Schema` artifact tab.
- `refresh_user_field_schema`: update the same `User Field Schema` tab with the refreshed/discovered schema.
- `reorder_user_field_schema`: update the same `User Field Schema` tab with the reordered columns.
- `update_user_field_schema`: render an inline status card in chat; if the canonical schema artifact tab is already open, update that tab to reflect the current schema.

Do not create a new artifact tab for every schema update/reorder/refresh by
default. If the operator explicitly asks to compare before/after schema states,
Agent Edge can duplicate or snapshot the tab before applying the operation.

## Leave To Agent Edge

Do not solve these in Moodle MCP Server:

- artifact tab creation or tab reuse
- detail-card UI layout
- missing-value display as `—`
- suppressing bootstrap/system artifacts
- prompt text telling the model not to restate fields
- SSE `artifact_update` events
- active-table operations
- chart/report/KPI rendering
- browser-level validation

Agent Edge owns those.

## Freeze Criteria

Server response work can be considered done when:

- ✅ all registered core and schema tools return contract-valid `ToolResponse` objects for visible paths
- ✅ `get_course` has explicit `compact_card` presentation; `get_user` and single-result `search_users` already had card presentation
- ✅ action/status tools are either `none` or structured inline status records by convention
- ✅ representative contract tests pass (11 tests across list_courses and server-response-contract suites)
- ✅ no tool emits ad hoc client-facing shapes or non-contract `data.kind` values

**Status: Server response contract work is frozen as of 2026-09-26.**
Leave Moodle MCP Server alone for artifact work unless a new tool contract bug appears. New artifact behavior should happen in Agent Edge.
