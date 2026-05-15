"use client";

import { useMemo, useState } from "react";
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
  ChevronDown,
  ChevronUp,
  Database,
} from "lucide-react";

type ToolDataKind = "table" | "record" | "list" | "none";

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

function renderCellValue(value: unknown, key?: string) {
  const formatted = formatValue(value, key);

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
}: {
  columns: ToolColumn[];
  rows: Array<Record<string, unknown>>;
  pagination?: ToolPagination;
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

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="max-h-96 overflow-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left text-xs">
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
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-slate-50 bg-white">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-3 py-10 text-center text-slate-400">
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pagination && (
        <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
          <span>
            {rows.length > 0
              ? `Showing ${pagination.offset + 1}–${pagination.offset + rows.length}`
              : ""}
            {!pagination.hasMore && pagination.total > 0 ? ` of ${pagination.total}` : ""}
          </span>
          {pagination.hasMore && (
            <span className="font-medium text-slate-400">More available</span>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRecord({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record);

  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white p-4 text-xs sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="mb-0.5 font-medium uppercase tracking-wide text-slate-400">{formatLabel(key)}</dt>
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

function ResultData({ result }: { result: StructuredToolResult }) {
  const { data } = result;

  switch (data.kind) {
    case "table":
      return data.columns && data.rows ? (
        <ResultTable columns={data.columns} rows={data.rows} pagination={data.pagination} />
      ) : null;
    case "record":
      return data.record ? <ResultRecord record={data.record} /> : null;
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

export function ToolResultView({ result }: { result: StructuredToolResult }) {
  const { context } = result;
  const hasMetrics = context.metrics && Object.keys(context.metrics).length > 0;
  const hasWarnings = context.warnings && context.warnings.length > 0;

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
      {result.error && typeof result.error !== "string" && (
        <div className="rounded-xl border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-xs">
          <p className="font-medium text-rose-700/80">{result.error.message}</p>
          <p className="mt-1 text-[11px] text-rose-500/80">
            {result.error.code} · {result.error.kind}
            {!result.error.canRetry ? "" : " · retry possible"}
          </p>
          {result.error.actionRequired && (
            <p className="mt-2 text-rose-600/80">Action: {result.error.actionRequired}</p>
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

      {/* Data — the hero */}
      <ResultData result={result} />
    </div>
  );
}
