# Architecture Decisions

## Tool Action Interactions (2026-05-31)

**Need**: The dashboard's `interactions` contract currently supports `row_actions` with
buttons that submit chat messages (e.g. "list courses for user {{id}}"). We need a
parallel mechanism for buttons that directly call MCP tools without an LLM round-trip.

**First use case**: "Discover Fields" button on `get_user_field_schema` error response
to trigger `refresh_user_field_schema`.

**Implementation**: `ToolResultView` needs a new action type (`tool_actions`) that calls
the MCP client's `callTool()` directly and renders the result inline. This is distinct
from `row_actions` which submits a templated user message.

**Dependency**: The MCP client (`packages/client/lib/mcp-client.ts`) already has
`callTool()` exposed to the API route. `ToolResultView` would need a callback prop
or context access to invoke it.
