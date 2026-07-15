import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DATE_PRESETS, todayIso, addDaysIso, type Grain } from './dates'

export type Cohort = 'ship' | 'placed'

export interface GlobalFilters {
  preset: string // a DATE_PRESETS key or 'custom'
  start: string
  end: string
  grain: Grain
  /** Empty array = all channels. */
  channels: string[]
  mfgTypes: string[]
  materials: string[]
  cohort: Cohort
}

export const ALL_CHANNELS = [
  'Xometry',
  'Web - Revenue Generating',
  'Web - Non-Revenue Generating',
  'PreForm - Revenue Generating',
  'PreForm - Non-Revenue Generating',
]

/** "Form Now only" = everything except Xometry (Web + PreForm categories). */
export const FORM_NOW_CHANNELS = ALL_CHANNELS.filter((c) => c !== 'Xometry')

export const ALL_MFG_TYPES = [
  'SLA - Form 4',
  'SLA - Form 4L',
  'SLA - Form 3',
  'SLA - Form 3L',
  'SLS - Fuse 1+',
  'SLS - Fuse X1',
]

const GRAIN_VALUES: Grain[] = ['day', 'week', 'month', 'quarter', 'year']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MATERIAL_RE = /^[A-Za-z0-9._ -]{1,40}$/

/**
 * Drop anything a stale bookmark or hand-edited URL could smuggle in that the
 * server's zod schemas would reject — otherwise one bad param 400s every query.
 */
function sanitize(p: Partial<GlobalFilters>): Partial<GlobalFilters> {
  const out: Partial<GlobalFilters> = {}
  if (p.preset && (p.preset === 'custom' || DATE_PRESETS.some((x) => x.key === p.preset))) out.preset = p.preset
  if (p.start && DATE_RE.test(p.start)) out.start = p.start
  if (p.end && DATE_RE.test(p.end)) out.end = p.end
  if (p.grain && GRAIN_VALUES.includes(p.grain)) out.grain = p.grain
  if (p.channels) out.channels = p.channels.filter((c) => ALL_CHANNELS.includes(c))
  if (p.mfgTypes) out.mfgTypes = p.mfgTypes.filter((t) => ALL_MFG_TYPES.includes(t))
  if (p.materials) out.materials = p.materials.filter((m) => MATERIAL_RE.test(m))
  if (p.cohort === 'ship' || p.cohort === 'placed') out.cohort = p.cohort
  return out
}

const DEFAULTS: GlobalFilters = {
  preset: '12w',
  start: addDaysIso(todayIso(), -84),
  end: todayIso(),
  grain: 'week',
  channels: [],
  mfgTypes: [],
  materials: [],
  cohort: 'ship',
}

interface FiltersCtx {
  filters: GlobalFilters
  setFilters: (patch: Partial<GlobalFilters>) => void
  /** Convenience: params object for useNamedQuery — resolved dates + arrays. */
  queryParams: {
    start: string
    end: string
    grain: Grain
    channels: string[]
    mfgTypes: string[]
    materials: string[]
  }
}

const Ctx = createContext<FiltersCtx | null>(null)

const LS_KEY = 'fn.filters.v1'

function fromUrl(): Partial<GlobalFilters> | null {
  const sp = new URLSearchParams(window.location.search)
  if (!sp.has('preset') && !sp.has('start')) return null
  const arr = (k: string) => (sp.get(k) ? sp.get(k)!.split('|').filter(Boolean) : [])
  const out: Partial<GlobalFilters> = {}
  if (sp.get('preset')) out.preset = sp.get('preset')!
  if (sp.get('start')) out.start = sp.get('start')!
  if (sp.get('end')) out.end = sp.get('end')!
  if (sp.get('grain')) out.grain = sp.get('grain') as Grain
  if (sp.has('ch')) out.channels = arr('ch')
  if (sp.has('mt')) out.mfgTypes = arr('mt')
  if (sp.has('mat')) out.materials = arr('mat')
  if (sp.get('cohort')) out.cohort = sp.get('cohort') as Cohort
  return out
}

function fromStorage(): Partial<GlobalFilters> | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as Partial<GlobalFilters>) : null
  } catch {
    return null
  }
}

function resolveDates(f: GlobalFilters): GlobalFilters {
  if (f.preset !== 'custom') {
    const preset = DATE_PRESETS.find((p) => p.key === f.preset)
    if (preset) {
      const { start, end } = preset.range()
      return { ...f, start, end }
    }
  }
  return f
}

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setState] = useState<GlobalFilters>(() =>
    resolveDates({ ...DEFAULTS, ...sanitize(fromStorage() ?? {}), ...sanitize(fromUrl() ?? {}) }),
  )

  const setFilters = (patch: Partial<GlobalFilters>) => {
    setState((prev) => resolveDates({ ...prev, ...patch }))
  }

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(filters))
    } catch {
      /* private mode */
    }
    const sp = new URLSearchParams(window.location.search)
    sp.set('preset', filters.preset)
    sp.set('start', filters.start)
    sp.set('end', filters.end)
    sp.set('grain', filters.grain)
    filters.channels.length ? sp.set('ch', filters.channels.join('|')) : sp.delete('ch')
    filters.mfgTypes.length ? sp.set('mt', filters.mfgTypes.join('|')) : sp.delete('mt')
    filters.materials.length ? sp.set('mat', filters.materials.join('|')) : sp.delete('mat')
    sp.set('cohort', filters.cohort)
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`)
  }, [filters])

  const value = useMemo<FiltersCtx>(
    () => ({
      filters,
      setFilters,
      queryParams: {
        start: filters.start,
        end: filters.end,
        grain: filters.grain,
        channels: filters.channels,
        mfgTypes: filters.mfgTypes,
        materials: filters.materials,
      },
    }),
    [filters],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useFilters(): FiltersCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useFilters must be used inside FiltersProvider')
  return ctx
}
