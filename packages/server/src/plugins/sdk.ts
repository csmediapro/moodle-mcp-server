/**
 * Plugin SDK — the public API surface for writing moodle-mcp-server plugins.
 *
 * Plugin authors import from this module instead of reaching into server
 * internals. This keeps the AGPL boundary clean: the server publishes a
 * stable interface, plugins consume it.
 *
 * Usage:
 *   import { buildToolResponse, extractSilo, hasCapability } from "@moodle-mcp/server/sdk";
 *
 * Re-exports:
 *   - Response builders (buildToolResponse, buildToolErrorResponse)
 *   - Silo helpers (extractSilo, filterUsersBySilo, matchesSilo, stripSilo)
 *   - Capability checking (hasCapability)
 *   - Error class (MoodleAPIError)
 *   - Types (MoodleClient, MoodleCapabilities, PluginContext, MCPServerPlugin, etc.)
 *   - Cache access via PluginContext.cache (added in this version)
 */

// Response builders
export {
  buildToolResponse,
  buildToolErrorResponse,
} from "../tools/response-types.js";
export type {
  ToolColumn,
  ToolPagination,
  ToolPresentation,
  ToolDataBlock,
  ToolEntityAction,
  ToolEntityRef,
  ToolEntity,
  ToolContextBlock,
  ToolResolutionBlock,
  ToolInteractionAction,
  ToolRowInteractionsBlock,
  ToolActionInteractionsBlock,
  ToolInteractionsBlock,
  ToolMetaBlock,
  ToolErrorBlock,
  ToolResponse,
} from "../tools/response-types.js";

// Silo helpers
export {
  extractSilo,
  stripSilo,
  matchesSilo,
  filterUsersBySilo,
} from "../tools/silo.js";
export type { SiloConstraint } from "../tools/silo.js";

// Capability checking
export { hasCapability } from "../moodle/capabilities.js";
export type { MoodleCapabilities } from "../moodle/capabilities.js";

// Moodle client + error
export { MoodleClient, MoodleAPIError } from "../moodle/client.js";
export type { MoodleAPICall, MoodleError } from "../moodle/client.js";

// Plugin contracts
export { PluginManifestSchema } from "./contracts.js";
export type {
  PluginManifest,
  PluginContext,
  PluginContextCache,
  ToolModule,
  MCPServerPlugin,
  LoadedPlugin,
  AgentRegistration,
  AgentIntentRoute,
  AgentToolRewrite,
  AgentContinuationAction,
  AgentCapture,
  AgentArgCapture,
  AgentFilterCapture,
  AgentCaptureTransform,
} from "./contracts.js";

// Course/category types (useful for plugin return types)
export type { Course, Category } from "../tools/cache.js";

// User field schema (used by user-directory plugin)
export {
  loadSchema,
  getDisplayFields,
  getDisplayFieldDefs,
  type UserFieldSchema,
  type UserFieldDef,
  type DisplayFieldDef,
} from "../schema/user-fields.js";

// Course search helper (used by get-user-progress-report plugin)
export { searchCoursesByName } from "../tools/search-courses-by-name.js";

// Cache helpers (used by plugins that need cached course/category data)
export { getCourses, getCategories } from "../tools/cache.js";