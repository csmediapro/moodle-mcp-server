interface ToolResultContext {
  summary?: unknown;
  metrics?: unknown;
  entities?: unknown;
  primaryEntity?: unknown;
  highlights?: unknown;
  suggestedQueries?: unknown;
  fields?: unknown;
  warnings?: unknown;
}

interface ToolResultResolution {
  scope?: unknown;
  resolvedParentId?: unknown;
  resolvedParentName?: unknown;
  resolvedParentPath?: unknown;
}

interface ToolResultError {
  code?: unknown;
  message?: unknown;
  kind?: unknown;
  canRetry?: unknown;
  actionRequired?: unknown;
}

interface ToolResultInteractions {
  mode?: unknown;
  actions?: unknown;
  rowActions?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBulletList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : String(item)))
        .filter(Boolean)
    : [];
}

function formatJsonInline(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatEntityLine(entity: Record<string, unknown>): string | null {
  const type = typeof entity.type === "string" && entity.type.trim()
    ? entity.type.trim()
    : null;
  const id = entity.id;
  if (!type || (typeof id !== "string" && typeof id !== "number")) {
    return null;
  }

  const parts = [`${type} id=${String(id)}`];
  if (typeof entity.label === "string" && entity.label.trim()) {
    parts.push(`label=${JSON.stringify(entity.label.trim())}`);
  }
  if (isRecord(entity.fields) && Object.keys(entity.fields).length > 0) {
    const fields = Object.entries(entity.fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    parts.push(`fields: ${fields}`);
  }
  return parts.join(" ");
}

function formatActionLine(action: Record<string, unknown>): string | null {
  const tool = typeof action.tool === "string" && action.tool.trim()
    ? action.tool.trim()
    : null;
  if (!tool) {
    return null;
  }

  const label = typeof action.label === "string" && action.label.trim()
    ? ` ${JSON.stringify(action.label.trim())}`
    : "";
  const args = isRecord(action.args) ? ` ${formatJsonInline(action.args)}` : "";
  return `- ${tool}${args}${label}`;
}

export function formatToolResultForLLM(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.context)) {
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  const context = result.context as ToolResultContext;
  const interactions = isRecord(result.interactions)
    ? (result.interactions as ToolResultInteractions)
    : null;
  const resolution = isRecord(result.resolution)
    ? (result.resolution as ToolResultResolution)
    : null;
  const lines: string[] = [];

  if (typeof result.error === "string" && result.error.trim()) {
    lines.push(`Error: ${result.error}`);
  } else if (isRecord(result.error)) {
    const error = result.error as ToolResultError;
    if (typeof error.message === "string" && error.message.trim()) {
      lines.push(`Error: ${error.message}`);
    }
    if (typeof error.kind === "string" && error.kind.trim()) {
      lines.push(`Error kind: ${error.kind}`);
    }
    if (typeof error.actionRequired === "string" && error.actionRequired.trim()) {
      lines.push(`Action required: ${error.actionRequired}`);
    }
  }

  if (typeof context.summary === "string" && context.summary.trim()) {
    lines.push(`Summary: ${context.summary}`);
  }

  if (isRecord(context.metrics) && Object.keys(context.metrics).length > 0) {
    const metricsLine = Object.entries(context.metrics)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    lines.push(`Metrics: ${metricsLine}`);
  }

  if (isRecord(context.primaryEntity)) {
    const primary = formatEntityLine(context.primaryEntity);
    if (primary) {
      lines.push(`Primary entity: ${primary}`);
    }
  }

  if (Array.isArray(context.entities) && context.entities.length > 0) {
    const entityLines: string[] = [];
    const actionLines: string[] = [];

    for (const item of context.entities) {
      if (!isRecord(item)) continue;

      const entityLine = formatEntityLine(item);
      if (entityLine) {
        entityLines.push(`- ${entityLine}`);
      }

      if (Array.isArray(item.actions)) {
        for (const action of item.actions) {
          if (!isRecord(action)) continue;
          const actionLine = formatActionLine(action);
          if (actionLine) {
            actionLines.push(actionLine);
          }
        }
      }
    }

    if (entityLines.length > 0) {
      lines.push("Entities:");
      lines.push(...entityLines);
    }

    if (actionLines.length > 0) {
      lines.push("Available structured actions:");
      lines.push(...actionLines);
    }
  }

  if (interactions) {
    const structuredActionLines: string[] = [];
    const actions = interactions.mode === "tool_actions"
      ? interactions.actions
      : interactions.mode === "row_actions"
        ? interactions.rowActions
        : null;

    if (Array.isArray(actions)) {
      for (const action of actions) {
        if (!isRecord(action)) continue;
        const actionLine = formatActionLine(action);
        if (actionLine) {
          structuredActionLines.push(actionLine);
        }
      }
    }

    if (structuredActionLines.length > 0) {
      lines.push("Available result actions:");
      lines.push(...structuredActionLines);
    }
  }

  const highlights = toBulletList(context.highlights);
  if (highlights.length > 0) {
    lines.push("Highlights:");
    for (const item of highlights) {
      lines.push(`- ${item}`);
    }
  }

  const suggestedQueries = toBulletList(context.suggestedQueries);
  if (suggestedQueries.length > 0) {
    lines.push("Suggested follow-up queries:");
    for (const item of suggestedQueries) {
      lines.push(`- ${item}`);
    }
  }

  const fields = toBulletList(context.fields);
  if (fields.length > 0) {
    lines.push(`Available fields: ${fields.join(", ")}`);
  }

  const warnings = toBulletList(context.warnings);
  if (warnings.length > 0) {
    lines.push("Warnings:");
    for (const item of warnings) {
      lines.push(`- ${item}`);
    }
  }

  if (resolution) {
    if (typeof resolution.scope === "string" && resolution.scope.trim()) {
      lines.push(`Resolution scope: ${resolution.scope}`);
    }

    const resolutionParts: string[] = [];
    if (resolution.resolvedParentId !== undefined && resolution.resolvedParentId !== null) {
      resolutionParts.push(`parentid=${String(resolution.resolvedParentId)}`);
    }
    if (typeof resolution.resolvedParentName === "string" && resolution.resolvedParentName.trim()) {
      resolutionParts.push(`parentname=${resolution.resolvedParentName}`);
    }
    if (typeof resolution.resolvedParentPath === "string" && resolution.resolvedParentPath.trim()) {
      resolutionParts.push(`parentpath=${resolution.resolvedParentPath}`);
    }
    if (resolutionParts.length > 0) {
      lines.push(`Resolved hierarchy: ${resolutionParts.join(", ")}`);
    }
  }

  if (lines.length === 0) {
    return JSON.stringify(result, null, 2);
  }

  return lines.join("\n");
}
