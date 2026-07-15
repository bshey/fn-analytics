import { useEffect, useRef, useState } from 'react'

interface Option {
  value: string
  label: string
}

interface Props {
  label: string
  options: Option[]
  /** Empty selection means "all". */
  selected: string[]
  onChange: (values: string[]) => void
}

export function MultiSelect({ label, options, selected, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const summary = selected.length === 0 ? 'All' : selected.length === 1 ? optionsLabel(options, selected[0]) : `${selected.length} selected`

  return (
    <div ref={root} className="relative">
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        <span className="text-sub">{label}</span>
        <span className="max-w-36 truncate font-medium">{summary}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-faint">
          <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-line bg-white p-1.5 shadow-lg">
          <button
            className="mb-1 w-full rounded px-2 py-1 text-left text-[12px] text-accent hover:bg-page"
            onClick={() => onChange([])}
          >
            All {label.toLowerCase()}
          </button>
          {options.map((o) => {
            const on = selected.includes(o.value)
            return (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-page">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])
                  }
                  className="accent-accent"
                />
                <span className="truncate">{o.label}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

function optionsLabel(options: Option[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value
}
