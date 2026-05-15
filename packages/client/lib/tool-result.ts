interface ToolResultContext {
  summary?: unknown;
  metrics?: unknown;
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

export function formatToolResultForLLM(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.context)) {
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  const context = result.context as ToolResultContext;
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
