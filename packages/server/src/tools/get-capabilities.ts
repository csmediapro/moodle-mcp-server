import { z } from "zod";
import { buildToolResponse } from "./response-types.js";

export const name = "get_capabilities";

export const description =
  "Show the effective registered tool catalog for this Moodle MCP server. " +
  "Returns currently callable tools grouped by source: core tools and plugin tools. " +
  "Table view shows Tool, Source, and Description.";

export const inputSchema = z.object({});

export type ToolSource = "core" | "plugin";

export interface ToolCatalogEntry {
  name: string;
  description: string;
  source: ToolSource;
  plugin?: {
    id: string;
    name: string;
  };
}

export function createHandler(getToolCatalog: () => ToolCatalogEntry[]) {
  return async (args: unknown) => {
    inputSchema.parse(args ?? {});

    const tools = getToolCatalog();
    const coreTools = tools.filter((tool) => tool.source === "core");
    const pluginTools = tools.filter((tool) => tool.source === "plugin");

    return buildToolResponse({
      meta: {
        tool: name,
        title: "Capabilities",
        resultCount: tools.length,
        entity: "tool_catalog",
      },
      data: {
        kind: "table",
        presentation: "table",
        title: "Registered Tools",
        columns: [
          { key: "name", label: "Tool" },
          { key: "source", label: "Source" },
          { key: "description", label: "Description" },
        ],
        rows: tools.map((tool) => ({
          name: tool.name,
          source: tool.source,
          description: tool.description,
        })),
      },
      context: {
        summary: `You have ${tools.length} registered tool${tools.length === 1 ? "" : "s"} available. They cover ${coreTools.length > 0 ? "core Moodle functionality" : "no core tools"}${pluginTools.length > 0 ? ` and ${pluginTools.length} plugin${pluginTools.length === 1 ? "" : "s"}` : ""}.`,
        metrics: {
          toolCount: tools.length,
          coreToolCount: coreTools.length,
          pluginToolCount: pluginTools.length,
        },
        fields: [
          "name",
          "description",
          "source",
          "plugin.id",
          "plugin.name",
        ],
        ...(pluginTools.length === 0 && {
          highlights: [
            "Plugin support is available, but no plugins are installed yet. "+
            "Useful plugin ideas might include gradebook analytics, enrollment automation, "+
            "quiz/question-bank tools, or LMS reporting dashboards."
          ]
        })
      },
    });
  };
}
