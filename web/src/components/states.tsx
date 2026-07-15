export function Skeleton({ height = 320 }: { height?: number }) {
  return (
    <div className="animate-pulse space-y-3 p-1" style={{ height }} aria-label="Loading">
      <div className="h-4 w-1/3 rounded bg-line" />
      <div className="rounded-lg bg-line/60" style={{ height: height - 60 }} />
    </div>
  )
}

export function EmptyState({ text = 'No data for the selected filters.' }: { text?: string }) {
  return <div className="flex h-40 items-center justify-center text-[13px] text-faint">{text}</div>
}

export function ErrorState({ error }: { error: (Error & { hint?: string }) | null | undefined }) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="text-[13px] font-medium text-bad">{error?.message ?? 'Something went wrong.'}</div>
      {error?.hint && <div className="max-w-md text-[12px] text-sub">{error.hint}</div>}
    </div>
  )
}
