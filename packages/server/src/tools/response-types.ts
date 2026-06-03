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

export type ToolPresentation = "table" | "compact_card" | "full_card";

export interface ToolDataBlock {
  kind: "table" | "record" | "list" | "none";
  presentation?: ToolPresentation;
  title?: string;
  columns?: ToolColumn[];
  rows?: Array<Record<string, unknown>>;
  record?: Record<string, unknown>;
  items?: unknown[];
  pagination?: ToolPagination;
}

export interface ToolEntityAction {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  style?: "primary" | "secondary";
}

export interface ToolEntityRef {
  type: string;
  id: string | number;
}

export interface ToolEntity extends ToolEntityRef {
  label?: string;
  fields?: Record<string, unknown>;
  actions?: ToolEntityAction[];
}

export interface ToolContextBlock {
  summary: string;
  metrics?: Record<string, string | number | boolean | null>;
  entities?: ToolEntity[];
  primaryEntity?: ToolEntityRef;
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

export interface ToolInteractionAction {
  type: "button";
  label: string;
  template?: string;
  tool?: string;
  args?: Record<string, unknown>;
  argsFromRow?: Record<string, string>;
  style?: "primary" | "secondary";
}

export interface ToolRowInteractionsBlock {
  mode: "row_actions";
  prompt?: string;
  submitAs?: "user_message" | "assistant_context";
  rowKey?: string;
  rowLabelFields?: string[];
  rowActions: ToolInteractionAction[];
}

export interface ToolActionInteractionsBlock {
  mode: "tool_actions";
  prompt?: string;
  submitAs?: "user_message" | "assistant_context";
  actions: ToolInteractionAction[];
}

export type ToolInteractionsBlock =
  | ToolRowInteractionsBlock
  | ToolActionInteractionsBlock;

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
  interactions?: ToolInteractionsBlock;
  error?: string | ToolErrorBlock;
}

export function buildToolResponse(input: {
  ok?: boolean;
  meta?: Omit<ToolMetaBlock, "generatedAt"> & { generatedAt?: string };
  data: ToolDataBlock;
  context: ToolContextBlock;
  resolution?: ToolResolutionBlock;
  interactions?: ToolInteractionsBlock;
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
    ...(input.interactions ? { interactions: input.interactions } : {}),
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
  interactions?: ToolInteractionsBlock;
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
    interactions: input.interactions,
  });
}
