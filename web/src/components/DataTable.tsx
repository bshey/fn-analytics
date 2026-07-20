import { useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { downloadCsv } from '../lib/csv'

interface Props<T> {
  data: T[]
  columns: ColumnDef<T, any>[]
  initialSort?: SortingState
  csvName?: string
  /** Cap rendered rows (table still exports everything). */
  maxRows?: number
  /** Fit the page width — wrap cell content instead of scrolling horizontally inside the card. */
  fit?: boolean
  onRowClick?: (row: T) => void
  emptyText?: string
}

/**
 * Sortable data table (TanStack v8). Column meta: { align: 'right' } right-aligns
 * with tabular figures — use for every numeric column. meta.className is applied
 * to the column's th and td — use 'whitespace-nowrap' for dates and 'w-full' on
 * ONE flexible column to make it absorb the table's slack width.
 */
export function DataTable<T>({ data, columns, initialSort = [], csvName, maxRows, fit = false, onRowClick, emptyText = 'No rows.' }: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort)
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const rows = table.getRowModel().rows
  const shown = maxRows ? rows.slice(0, maxRows) : rows

  if (!data.length) return <div className="py-8 text-center text-[13px] text-faint">{emptyText}</div>

  return (
    <div>
      {csvName && (
        <div className="mb-1.5 flex justify-end">
          <button
            className="btn !px-2 !py-1 text-[11.5px]"
            onClick={() => downloadCsv(csvName, data as Record<string, unknown>[])}
          >
            CSV
          </button>
        </div>
      )}
      <div className={fit ? 'rounded-lg border border-line' : 'overflow-x-auto rounded-lg border border-line'}>
        <table className="w-full border-collapse bg-white text-[13px]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as { align?: string; className?: string } | undefined
                  const align = meta?.align
                  return (
                    <th
                      key={h.id}
                      onClick={h.column.getToggleSortingHandler()}
                      className={`cursor-pointer select-none border-b border-line bg-[#fafbfc] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-sub ${
                        align === 'right' ? 'text-right' : 'text-left'
                      } ${meta?.className ?? ''}`}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getIsSorted() === 'asc' ? ' ↑' : h.column.getIsSorted() === 'desc' ? ' ↓' : ''}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-line/60 last:border-b-0 ${onRowClick ? 'cursor-pointer hover:bg-page' : ''}`}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as { align?: string; className?: string } | undefined
                  const align = meta?.align
                  return (
                    <td
                      key={cell.id}
                      className={`px-3 py-1.5 ${align === 'right' ? 'text-right tabular-nums' : 'text-left'} ${meta?.className ?? ''}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {maxRows && rows.length > maxRows && (
        <div className="mt-1.5 text-[11.5px] text-faint">
          Showing {maxRows.toLocaleString()} of {rows.length.toLocaleString()} rows — export CSV for all.
        </div>
      )}
    </div>
  )
}
