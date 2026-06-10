"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  RefreshCw,
  X,
} from "lucide-react";

type ToolDataKind = "table" | "record" | "list" | "none";
type ToolPresentation = "table" | "compact_card" | "full_card";

interface ToolColumn {
  key: string;
  label: string;
}

interface ToolPagination {
  offset: number;
  limit: number;
  total: number;
  hasMore?: boolean;
}

interface ToolInteractionAction {
  type: "button";
  label: string;
  template?: string;
  tool?: string;
  args?: Record<string, unknown>;
  argsFromRow?: Record<string, string>;
  style?: "primary" | "secondary";
}

interface ToolRowInteractions {
  mode: "row_actions";
  prompt?: string;
  submitAs?: "user_message" | "assistant_context";
  rowKey?: string;
  rowLabelFields?: string[];
  rowActions: ToolInteractionAction[];
}

interface ToolActionInteractions {
  mode: "tool_actions";
  prompt?: string;
  submitAs?: "user_message" | "assistant_context";
  actions: ToolInteractionAction[];
}

type ToolInteractions = ToolRowInteractions | ToolActionInteractions;

interface ToolEntityAction {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  style?: "primary" | "secondary";
}

interface ToolEntityRef {
  type: string;
  id: string | number;
}

interface ToolEntity extends ToolEntityRef {
  label?: string;
  fields?: Record<string, unknown>;
  actions?: ToolEntityAction[];
}

export interface StructuredToolResult {
  ok?: boolean;
  error?:
    | string
    | {
        code: string;
        message: string;
        kind: string;
        canRetry: boolean;
        actionRequired?: string;
      };
  meta?: {
    tool: string;
    title: string;
    generatedAt: string;
    resultCount?: number;
    entity?: string;
    entityId?: string | number;
  };
  data: {
    kind: ToolDataKind;
    presentation?: ToolPresentation;
    title?: string;
    columns?: ToolColumn[];
    rows?: Array<Record<string, unknown>>;
    record?: Record<string, unknown>;
    items?: unknown[];
    pagination?: ToolPagination;
  };
  context: {
    summary: string;
    metrics?: Record<string, string | number | boolean | null>;
    entities?: ToolEntity[];
    primaryEntity?: ToolEntityRef;
    highlights?: string[];
    suggestedQueries?: string[];
    fields?: string[];
    warnings?: string[];
  };
  resolution?: {
    scope: "all" | "top_level" | "children_of_parent";
    resolvedParentId?: number | null;
    resolvedParentName?: string | null;
    resolvedParentPath?: string | null;
  };
  interactions?: ToolInteractions;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isStructuredToolResult(value: unknown): value is StructuredToolResult {
  return (
    isObject(value) &&
    isObject(value.data) &&
    isObject(value.context) &&
    typeof value.context.summary === "string" &&
    typeof value.data.kind === "string"
  );
}

function isIsoDate(value: string): boolean {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

function formatValue(value: unknown, key?: string): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "—";
  }

  if (typeof value === "number") {
    if (key?.endsWith("pct") || key?.includes("percent")) {
      return `${value}%`;
    }
    return String(value);
  }

  if (typeof value === "string") {
    if (value === "never") {
      return value;
    }
    if (isIsoDate(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleString();
      }
    }
    return value;
  }

  return JSON.stringify(value);
}

function formatLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveActionTemplate(
  template: string,
  row: Record<string, unknown>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const raw = row[String(key).trim()];
    return raw == null ? "" : String(raw);
  });
}

function resolveActionArgs(
  action: ToolInteractionAction,
  row?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!action.argsFromRow || !row) {
    return action.args;
  }

  const args: Record<string, unknown> = { ...(action.args ?? {}) };
  for (const [argKey, rowKey] of Object.entries(action.argsFromRow)) {
    args[argKey] = row[rowKey];
  }
  return args;
}

function resolveActionMessage(
  action: ToolInteractionAction,
  row?: Record<string, unknown>
): string {
  if (action.template) {
    return row ? resolveActionTemplate(action.template, row) : action.template;
  }

  if (action.tool) {
    const args = resolveActionArgs(action, row);
    return args && Object.keys(args).length > 0
      ? `Run ${action.tool} with ${JSON.stringify(args)}`
      : `Run ${action.tool}`;
  }

  return action.label;
}

function renderCellValue(value: unknown, key?: string) {
  const formatted = formatValue(value, key);

  if ((key === "display" || key === "filterable") && typeof value === "boolean") {
    return value ? (
      <span
        aria-label="Enabled"
        title="Enabled"
        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-300"
      >
        <Check className="h-3.5 w-3.5" />
      </span>
    ) : (
      <span
        aria-label="Disabled"
        title="Disabled"
        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-100 text-rose-700 ring-1 ring-inset ring-rose-300"
      >
        <X className="h-3.5 w-3.5" />
      </span>
    );
  }

  if (key === "status" && typeof formatted === "string") {
    const tone =
      formatted === "Completed"
        ? "bg-emerald-100/80 text-emerald-700/80 ring-emerald-300/80"
        : formatted === "In Progress"
          ? "bg-amber-100/80 text-amber-700/80 ring-amber-300/80"
          : formatted === "Not Started"
            ? "bg-slate-100/80 text-slate-500/80 ring-slate-300/80"
            : "bg-gray-100/80 text-gray-500/80 ring-gray-300/80";

    return (
      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}>
        {formatted}
      </span>
    );
  }

  if ((key?.endsWith("pct") || key?.includes("percent")) && formatted !== "—") {
    return (
      <span className="inline-flex rounded-full bg-blue-100/80 px-2 py-0.5 text-[11px] font-medium text-blue-600/80 ring-1 ring-inset ring-blue-300/80">
        {formatted}
      </span>
    );
  }

  return <span className="whitespace-normal break-words text-slate-600">{formatted}</span>;
}

function ResultTable({
  columns,
  rows,
  pagination,
  interactions,
  onAction,
  onPage,
  pageLoading,
  pageError,
}: {
  columns: ToolColumn[];
  rows: Array<Record<string, unknown>>;
  pagination?: ToolPagination;
  interactions?: ToolInteractions;
  onAction?: (message: string) => void;
  onPage?: (offset: number) => void;
  pageLoading?: boolean;
  pageError?: string | null;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columns.map((column) => ({
        accessorFn: (row) => row[column.key],
        id: column.key,
        header: ({ column: tableColumn }) => (
          <button
            type="button"
            className="flex items-center gap-1 font-medium text-slate-500 transition hover:text-slate-900"
            onClick={tableColumn.getToggleSortingHandler()}
          >
            <span>{column.label}</span>
            {tableColumn.getIsSorted() === "asc" ? (
              <ChevronUp className="h-3 w-3" />
            ) : tableColumn.getIsSorted() === "desc" ? (
              <ChevronDown className="h-3 w-3" />
            ) : null}
          </button>
        ),
        cell: ({ getValue }) => renderCellValue(getValue(), column.key),
      })),
    [columns]
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const startRow = rows.length > 0 ? pagination ? pagination.offset + 1 : 1 : 0;
  const endRow = pagination ? pagination.offset + rows.length : rows.length;
  const canPagePrevious = !!pagination && pagination.offset > 0 && !pageLoading;
  const canPageNext = !!pagination && !!pagination.hasMore && !pageLoading;

  return (
    <div>
      <div className="rounded-xl border border-slate-200" style={{ overflowX: "auto" }}>
        <div className="max-h-96" style={{ overflowY: "auto" }}>
          <table className="min-w-full divide-y divide-slate-100 text-left text-xs table-auto">
            <thead className="sticky top-0 z-10 bg-slate-50">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                  {interactions?.mode === "row_actions" && interactions.rowActions.length > 0 && (
                    <th className="w-24 px-3 py-2" aria-label="Actions" />
                  )}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-slate-50 bg-white">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + (interactions?.mode === "row_actions" ? 1 : 0)} className="px-3 py-10 text-center text-slate-400">
                    No rows returned.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="even:bg-slate-50/40 hover:bg-blue-50/30">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                    {interactions?.mode === "row_actions" && interactions.rowActions.length > 0 && (
                      <td className="px-3 py-2 align-middle">
                        <div className="flex flex-wrap gap-1.5">
                          {interactions.rowActions.map((action, index) => {
                            const resolved = resolveActionMessage(action, row.original);
                            return (
                              <button
                                key={`${action.label}-${index}`}
                                type="button"
                                onClick={() => onAction?.(resolved)}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: "2px 10px",
                                  fontSize: 11,
                                  fontWeight: 500,
                                  lineHeight: "16px",
                                  borderRadius: 9999,
                                  border: "none",
                                  cursor: "pointer",
                                  backgroundColor: action.style === "secondary" ? "#fff" : "#3b82f6",
                                  color: action.style === "secondary" ? "#475569" : "#fff",
                                  ...(action.style === "secondary" ? { border: "1px solid #e2e8f0" } : {}),
                                }}
                              >
                                {action.label}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {interactions?.prompt && (
        <p className="mt-2 text-[11px] text-slate-500">{interactions.prompt}</p>
      )}

      {pagination && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Showing {startRow}–{endRow} of {pagination.total}
            </span>
            {pageLoading && (
              <span className="font-medium text-blue-500">Loading page…</span>
            )}
            {pageError && (
              <span className="font-medium text-rose-500">{pageError}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!canPagePrevious}
              onClick={() => onPage?.(Math.max(0, pagination.offset - pagination.limit))}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              disabled={!canPageNext}
              onClick={() => onPage?.(pagination.offset + pagination.limit)}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span>Next</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {pageError && (
            <button
              type="button"
              onClick={() => onPage?.(pagination.offset)}
              className="text-[11px] font-medium text-blue-500 hover:text-blue-600"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRecord({
  record,
  columns,
  presentation,
}: {
  record: Record<string, unknown>;
  columns?: ToolColumn[];
  presentation?: ToolPresentation;
}) {
  const isCompact = presentation === "compact_card";
  const entries = isCompact && columns && columns.length > 0
    ? columns.map((column) => [column.key, record[column.key], column.label] as const)
    : Object.entries(record).map(([key, value]) => [key, value, formatLabel(key)] as const);

  return (
    <dl
      className={
        isCompact
          ? "grid grid-cols-1 gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white p-4 text-xs sm:grid-cols-2 lg:grid-cols-3"
          : "grid grid-cols-1 gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white p-4 text-xs sm:grid-cols-2"
      }
    >
      {entries.map(([key, value, label]) => (
        <div key={key}>
          <dt className="mb-0.5 font-medium uppercase tracking-wide text-slate-400">{label}</dt>
          <dd className="text-slate-700">{formatValue(value, key)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultList({ items }: { items: unknown[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
      {items.map((item, index) => (
        <li key={index}>{formatValue(item)}</li>
      ))}
    </ul>
  );
}

function ResultData({
  result,
  onAction,
  onPage,
  pageLoading,
  pageError,
}: {
  result: StructuredToolResult;
  onAction?: (message: string) => void;
  onPage?: (offset: number) => void;
  pageLoading?: boolean;
  pageError?: string | null;
}) {
  const { data } = result;

  switch (data.kind) {
    case "table":
      return data.columns && data.rows ? (
        <ResultTable
          columns={data.columns}
          rows={data.rows}
          pagination={data.pagination}
          interactions={result.interactions?.mode === "row_actions" ? result.interactions : undefined}
          onAction={onAction}
          onPage={onPage}
          pageLoading={pageLoading}
          pageError={pageError}
        />
      ) : null;
    case "record":
      return data.record ? (
        <ResultRecord
          record={data.record}
          columns={data.columns}
          presentation={data.presentation}
        />
      ) : null;
    case "list":
      return data.items ? <ResultList items={data.items} /> : null;
    case "none":
    default:
      return (
        <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
          No displayable data returned.
        </div>
      );
  }
}

function ToolActions({
  interactions,
  onAction,
}: {
  interactions?: ToolInteractions;
  onAction?: (message: string) => void;
}) {
  if (!interactions || interactions.mode !== "tool_actions" || interactions.actions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {interactions.actions.map((action, index) => (
        <button
          key={`${action.label}-${index}`}
          type="button"
          onClick={() => onAction?.(resolveActionMessage(action))}
          className={
            action.style === "secondary"
              ? "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
              : "inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600"
          }
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>{action.label}</span>
        </button>
      ))}
      {interactions.prompt && (
        <span className="text-[11px] text-slate-500">{interactions.prompt}</span>
      )}
    </div>
  );
}

export function ToolResultView({
  result,
  onAction,
  toolName,
  toolArgs,
}: {
  result: StructuredToolResult;
  onAction?: (message: string) => void;
  toolName?: string;
  toolArgs?: unknown;
}) {
  const [currentResult, setCurrentResult] = useState(result);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const { context } = currentResult;
  const hasMetrics = context.metrics && Object.keys(context.metrics).length > 0;
  const hasWarnings = context.warnings && context.warnings.length > 0;
  const hasPaginatedTable =
    currentResult.data.kind === "table" &&
    !!currentResult.data.pagination &&
    !!currentResult.data.columns &&
    !!currentResult.data.rows;
  const showToolActions = !hasPaginatedTable;

  useEffect(() => {
    setCurrentResult(result);
    setPageError(null);
    setPageLoading(false);
  }, [result]);

  async function handlePage(offset: number) {
    const pagination = currentResult.data.pagination;
    const resolvedTool = currentResult.meta?.tool || toolName;
    if (!pagination || !resolvedTool || pageLoading) return;

    const baseArgs =
      typeof toolArgs === "object" && toolArgs !== null && !Array.isArray(toolArgs)
        ? { ...(toolArgs as Record<string, unknown>) }
        : {};
    const nextArgs: Record<string, unknown> = {
      ...baseArgs,
      offset,
      limit: pagination.limit,
    };

    if (resolvedTool === "list_users") {
      nextArgs.confirmed = true;
      nextArgs.refresh = false;
    }

    setPageLoading(true);
    setPageError(null);

    try {
      const response = await fetch("/api/tool-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: resolvedTool,
          args: nextArgs,
        }),
      });

      const payload = await response.json() as { ok?: boolean; result?: unknown; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Tool action failed with ${response.status}`);
      }
      if (!isStructuredToolResult(payload.result)) {
        throw new Error("Tool action returned an unstructured result.");
      }

      setCurrentResult(payload.result);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setPageLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Metrics pills — compact, non-redundant */}
      {hasMetrics && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(context.metrics!).map(([key, value]) => (
            <div
              key={key}
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500"
            >
              <span className="font-medium text-slate-600">{formatLabel(key)}</span>{" "}
              {formatValue(value, key)}
            </div>
          ))}
        </div>
      )}

      {/* Error display */}
      {currentResult.error && typeof currentResult.error !== "string" && (
        <div className="rounded-xl border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-xs">
          <p className="font-medium text-rose-700/80">{currentResult.error.message}</p>
          <p className="mt-1 text-[11px] text-rose-500/80">
            {currentResult.error.code} · {currentResult.error.kind}
            {!currentResult.error.canRetry ? "" : " · retry possible"}
          </p>
          {currentResult.error.actionRequired && (
            <p className="mt-2 text-rose-600/80">Action: {currentResult.error.actionRequired}</p>
          )}
        </div>
      )}

      {/* Warnings — only when populated */}
      {hasWarnings && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-600/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            {context.warnings!.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        </div>
      )}

      {showToolActions && (
        <ToolActions interactions={currentResult.interactions} onAction={onAction} />
      )}

      {/* Data — the hero */}
      <ResultData
        result={currentResult}
        onAction={onAction}
        onPage={handlePage}
        pageLoading={pageLoading}
        pageError={pageError}
      />
    </div>
  );
}
