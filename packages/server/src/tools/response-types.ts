export interface ToolColumn {
  key: string;
  label: string;
}

export interface ToolPagination {
  offset: number;
  limit: number;
  total: number;
  hasMore?: boolean;
}

export interface ToolDataBlock {
  kind: "table" | "record" | "list" | "none";
  title?: string;
  columns?: ToolColumn[];
  rows?: Array<Record<string, unknown>>;
  record?: Record<string, unknown>;
  items?: unknown[];
  pagination?: ToolPagination;
}

export interface ToolContextBlock {
  summary: string;
  metrics?: Record<string, string | number | boolean | null>;
  highlights?: string[];
  suggestedQueries?: string[];
  fields?: string[];
  warnings?: string[];
}

export interface ToolResolutionBlock {
  scope: "all" | "top_level" | "children_of_parent";
  resolvedParentId?: number | null;
  resolvedParentName?: string | null;
  resolvedParentPath?: string | null;
}

export interface ToolMetaBlock {
  tool: string;
  title: string;
  generatedAt: string;
  resultCount?: number;
  entity?: string;
  entityId?: string | number;
}

export interface ToolErrorBlock {
  code: string;
  message: string;
  kind: "permission" | "validation" | "not_found" | "capability" | "upstream" | "unknown";
  canRetry: boolean;
  actionRequired?: string;
}

export interface ToolResponse {
  ok: boolean;
  meta?: ToolMetaBlock;
  data: ToolDataBlock;
  context: ToolContextBlock;
  resolution?: ToolResolutionBlock;
  error?: string | ToolErrorBlock;
}

export function buildToolResponse(input: {
  ok?: boolean;
  meta?: Omit<ToolMetaBlock, "generatedAt"> & { generatedAt?: string };
  data: ToolDataBlock;
  context: ToolContextBlock;
  resolution?: ToolResolutionBlock;
  error?: string | ToolErrorBlock;
}): ToolResponse {
  return {
    ok: input.ok ?? !input.error,
    ...(input.meta
      ? {
          meta: {
            ...input.meta,
            generatedAt: input.meta.generatedAt ?? new Date().toISOString(),
          },
        }
      : {}),
    data: input.data,
    context: input.context,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

export function buildToolErrorResponse(input: {
  error: string | ToolErrorBlock;
  summary: string;
  meta?: Omit<ToolMetaBlock, "generatedAt"> & { generatedAt?: string };
  highlights?: string[];
  suggestedQueries?: string[];
  warnings?: string[];
}): ToolResponse {
  return buildToolResponse({
    ok: false,
    error: input.error,
    meta: input.meta,
    data: {
      kind: "none",
      title: "No data returned",
    },
    context: {
      summary: input.summary,
      highlights: input.highlights,
      suggestedQueries: input.suggestedQueries,
      warnings: input.warnings,
    },
  });
}
