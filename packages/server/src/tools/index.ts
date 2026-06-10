import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";
import * as listCourses from "./list-courses.js";
import * as getCourse from "./get-course.js";
import * as listCourseUsers from "./list-course-users.js";
import * as listAssignments from "./list-assignments.js";
import * as getSiteInfo from "./get-site-info.js";
import * as listCategories from "./list-categories.js";
import * as getUser from "./get-user.js";
import * as listUserCourses from "./list-user-courses.js";
import * as searchUsers from "./search-users.js";
import * as searchCoursesByName from "./search-courses-by-name.js";
import * as manageCache from "./manage-cache.js";
import * as cacheStatus from "./cache-status.js";
import * as userSchema from "./user-schema.js";

/**
 * Tool module shape — each tool file exports this.
 */
interface ToolModule {
  name: string;
  description: string;
  inputSchema: Parameters<typeof zodToJsonSchema>[0];
  createHandler: (
    client: MoodleClient,
    caps: MoodleCapabilities
  ) => (args: unknown) => Promise<unknown>;
}

const TOOL_MODULES: ToolModule[] = [
  listCourses,
  getCourse,
  listCourseUsers,
  listAssignments,
  getSiteInfo,
  listCategories,
  getUser,
  listUserCourses,
  searchUsers,
  searchCoursesByName,
  cacheStatus,
  manageCache,
];

// Schema tools follow a slightly different module shape:
// - get_user_field_schema + update_user_field_schema are local-only (no Moodle client needed)
// - refresh_user_field_schema needs the Moodle client for discovery
const SCHEMA_DEFINITIONS: Tool[] = [
  {
    name: userSchema.getSchemaName,
    description: userSchema.getSchemaDescription,
    inputSchema: zodToJsonSchema(userSchema.getSchemaInput),
  },
  {
    name: userSchema.refreshSchemaName,
    description: userSchema.refreshSchemaDescription,
    inputSchema: zodToJsonSchema(userSchema.refreshSchemaInput),
  },
  {
    name: userSchema.updateSchemaName,
    description: userSchema.updateSchemaDescription,
    inputSchema: zodToJsonSchema(userSchema.updateSchemaInput),
  },
  {
    name: userSchema.reorderSchemaName,
    description: userSchema.reorderSchemaDescription,
    inputSchema: zodToJsonSchema(userSchema.reorderSchemaInput),
  },
];

/**
 * Build Tool definitions array for MCP server registration.
 */
export function buildToolDefinitions(): Tool[] {
  return [
    ...TOOL_MODULES.map((mod) => ({
      name: mod.name,
      description: mod.description,
      inputSchema: zodToJsonSchema(mod.inputSchema),
    })),
    ...SCHEMA_DEFINITIONS,
  ];
}

/**
 * Build a handlers map: tool_name → handler function.
 */
export function buildToolHandlers(
  client: MoodleClient,
  caps: MoodleCapabilities
): Record<string, (args: unknown) => Promise<unknown>> {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};

  for (const mod of TOOL_MODULES) {
    handlers[mod.name] = mod.createHandler(client, caps);
  }

  // Schema tools
  handlers[userSchema.getSchemaName] = userSchema.createGetSchemaHandler();
  handlers[userSchema.refreshSchemaName] = userSchema.createRefreshSchemaHandler(client);
  handlers[userSchema.updateSchemaName] = userSchema.createUpdateSchemaHandler();
  handlers[userSchema.reorderSchemaName] = userSchema.createReorderSchemaHandler();

  return handlers;
}
