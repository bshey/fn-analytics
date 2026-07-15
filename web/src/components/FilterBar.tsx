import { useLocation } from 'react-router-dom'
import { useDims, useRefreshAll } from '../lib/api'
import { useFilters, FORM_NOW_CHANNELS } from '../lib/filters'
import { DATE_PRESETS, type Grain } from '../lib/dates'
import { MultiSelect } from './MultiSelect'
import { Segmented } from './Segmented'

const GRAIN_OPTIONS: { value: Grain; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Qtr' },
  { value: 'year', label: 'Year' },
]

export function FilterBar() {
  const { filters, setFilters } = useFilters()
  const dims = useDims()
  const refreshAll = useRefreshAll()
  const { pathname } = useLocation()
  const showCohort = pathname.startsWith('/shipments')

  const formNowOnly =
    filters.channels.length === FORM_NOW_CHANNELS.length &&
    FORM_NOW_CHANNELS.every((c) => filters.channels.includes(c))

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-5 py-2.5">
      <select
        value={filters.preset}
        onChange={(e) => {
          const preset = e.target.value
          if (preset === 'custom') setFilters({ preset })
          else {
            const p = DATE_PRESETS.find((x) => x.key === preset)
            if (p) setFilters({ preset, ...p.range() })
          }
        }}
      >
        {DATE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom range</option>
      </select>

      {filters.preset === 'custom' && (
        <>
          <input type="date" value={filters.start} max={filters.end} onChange={(e) => setFilters({ start: e.target.value })} />
          <span className="text-faint">–</span>
          <input type="date" value={filters.end} min={filters.start} onChange={(e) => setFilters({ end: e.target.value })} />
        </>
      )}

      <Segmented options={GRAIN_OPTIONS} value={filters.grain} onChange={(grain) => setFilters({ grain })} size="sm" />

      <MultiSelect
        label="Channel"
        options={(dims.data?.channels ?? []).map((c) => ({ value: c, label: c }))}
        selected={filters.channels}
        onChange={(channels) => setFilters({ channels })}
      />
      <MultiSelect
        label="Type"
        options={(dims.data?.mfgTypes ?? []).map((t) => ({ value: t, label: t }))}
        selected={filters.mfgTypes}
        onChange={(mfgTypes) => setFilters({ mfgTypes })}
      />
      <MultiSelect
        label="Material"
        options={(dims.data?.materials ?? []).map((m) => ({ value: m.code, label: m.name }))}
        selected={filters.materials}
        onChange={(materials) => setFilters({ materials })}
      />

      <button
        className={`chip ${formNowOnly ? 'border-accent/40 bg-accent/5 text-accent' : ''}`}
        onClick={() => setFilters({ channels: formNowOnly ? [] : [...FORM_NOW_CHANNELS] })}
        title="Web + PreForm categories (excludes Xometry)"
      >
        Form Now only
      </button>

      {showCohort && (
        <Segmented
          options={[
            { value: 'ship', label: 'Due date' },
            { value: 'placed', label: 'Order placed' },
          ]}
          value={filters.cohort}
          onChange={(cohort) => setFilters({ cohort })}
          size="sm"
        />
      )}

      <div className="ml-auto">
        <button className="btn btn-accent" onClick={refreshAll} title="Bypass caches and re-run queries">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Refresh
        </button>
      </div>
    </div>
  )
}
