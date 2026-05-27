import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MoodleClient } from "../moodle/client.js";
import { MoodleCapabilities } from "../moodle/capabilities.js";
import { zodToJsonSchema } from "../utils/zod-to-json-schema.js";
import * as listCourses from "./list-courses.js";
import * as getCourse from "./get-course.js";
import * as listCourseUsers from "./list-course-users.js";
import * as listAssignments from "./list-assignments.js";
import * as getRecentActivity from "./get-recent-activity.js";
import * as getCourseCompletionReport from "./get-course-completion-report.js";
import * as getSiteInfo from "./get-site-info.js";
import * as listCategories from "./list-categories.js";
import * as getUser from "./get-user.js";
import * as listUserCourses from "./list-user-courses.js";
import * as searchUsers from "./search-users.js";

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
  getRecentActivity,
  getCourseCompletionReport,
  getSiteInfo,
  listCategories,
  getUser,
  listUserCourses,
  searchUsers,
];

/**
 * Build Tool definitions array for MCP server registration.
 */
export function buildToolDefinitions(): Tool[] {
  return TOOL_MODULES.map((mod) => ({
    name: mod.name,
    description: mod.description,
    inputSchema: zodToJsonSchema(mod.inputSchema),
  }));
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

  return handlers;
}
