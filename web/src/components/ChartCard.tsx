import { useRef, useState, type ReactNode, type RefObject } from 'react'
import type { EChartHandle } from './EChart'
import { downloadCsv, downloadPng } from '../lib/csv'
import { Skeleton, EmptyState, ErrorState } from './states'

interface Info {
  definition: string
  source: string
}

interface Props {
  title: string
  subtitle?: string
  /** "ℹ️ definition & source" popover content — required for metric trust. */
  info?: Info
  /** Rows for CSV export (usually the chart's underlying data). */
  csvRows?: Record<string, unknown>[]
  csvName?: string
  /** Ref to the EChart inside for PNG export. */
  chartRef?: RefObject<EChartHandle>
  isLoading?: boolean
  isFetching?: boolean
  error?: (Error & { hint?: string }) | null
  isEmpty?: boolean
  emptyText?: string
  /** Extra header controls (toggles etc.). */
  actions?: ReactNode
  height?: number
  children: ReactNode
}

export function ChartCard({
  title,
  subtitle,
  info,
  csvRows,
  csvName,
  chartRef,
  isLoading,
  isFetching,
  error,
  isEmpty,
  emptyText,
  actions,
  height = 340,
  children,
}: Props) {
  const [infoOpen, setInfoOpen] = useState(false)
  const infoBtn = useRef<HTMLButtonElement>(null)

  const body = error ? (
    <ErrorState error={error} />
  ) : isLoading ? (
    <Skeleton height={height} />
  ) : isEmpty ? (
    <EmptyState text={emptyText} />
  ) : (
    // Hold the previous render at reduced opacity on refetch — no skeleton flash.
    <div className={isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>{children}</div>
  )

  return (
    <section className="card relative p-4">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[13.5px] font-semibold">{title}</h3>
            {info && (
              <button
                ref={infoBtn}
                className="grid h-4 w-4 place-items-center rounded-full border border-line text-[10px] leading-none text-sub hover:bg-page"
                title="Definition & source"
                onClick={() => setInfoOpen((v) => !v)}
              >
                i
              </button>
            )}
          </div>
          {subtitle && <p className="mt-0.5 text-[12px] text-sub">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {csvRows && csvRows.length > 0 && (
            <button className="btn !px-2 !py-1 text-[11.5px]" onClick={() => downloadCsv(csvName ?? title, csvRows)}>
              CSV
            </button>
          )}
          {chartRef && (
            <button
              className="btn !px-2 !py-1 text-[11.5px]"
              onClick={() => {
                const url = chartRef.current?.getPngDataUrl()
                if (url) downloadPng(url, csvName ?? title)
              }}
            >
              PNG
            </button>
          )}
        </div>
      </header>
      {infoOpen && info && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setInfoOpen(false)} />
          <div className="absolute left-4 top-10 z-20 max-w-md rounded-lg border border-line bg-white p-3 text-[12px] shadow-lg">
            <p className="text-ink">{info.definition}</p>
            <p className="mt-1.5 font-mono text-[11px] text-faint">{info.source}</p>
          </div>
        </>
      )}
      {body}
    </section>
  )
}
