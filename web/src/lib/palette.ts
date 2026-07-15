/**
 * Design tokens & series color assignment.
 * Channel colors are mandated to match the existing Looker/HTML dashboards.
 * They pass CVD-separation validation (worst adjacent ΔE 36.4) but several are
 * low-contrast pastels — so every chart MUST ship a legend, tooltips, and a
 * table twin (the relief rule). Color follows the entity, never its rank:
 * assignments are sticky for the session.
 */

export const CHANNEL_COLORS: Record<string, string> = {
  Xometry: '#4C6EF5',
  'Web - Revenue Generating': '#C9A96A',
  'PreForm - Revenue Generating': '#7FB3E8',
  'Web - Non-Revenue Generating': '#E3CFA3',
  'PreForm - Non-Revenue Generating': '#C7E0F4',
}

/** Validated categorical palette (dataviz reference, fixed order — never cycle past 8; fold into "Other"). */
export const CATEGORICAL = [
  '#2a78d6', // blue
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
  '#e87ba4', // magenta
  '#eb6834', // orange
] as const

export const TIMING_BUCKETS = [
  '3+ days early',
  '1-2 days early',
  'On time',
  '1-2 days late',
  '3-5 days late',
  '6+ days late',
] as const

/** Diverging timing palette from the validated reference dashboard (styling target). */
export const TIMING_COLORS: Record<string, string> = {
  '3+ days early': '#1B7837',
  '1-2 days early': '#A6DBA0',
  'On time': '#4C6EF5',
  '1-2 days late': '#FDBF6F',
  '3-5 days late': '#F4A582',
  '6+ days late': '#B2182B',
}

/** Status colors — reserved for state (good/warning/serious/critical), never for a series. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

/** WIP status → color (ordered pipeline states use an ordinal blue ramp; exception states use status hues). */
export const ORDER_STATUS_COLORS: Record<string, string> = {
  QUOTING: '#9ec5f4',
  ACCEPTED: '#5598e7',
  PRINTING: '#256abf',
  ON_HOLD: '#fab219',
  SHIPPED: '#0ca30c',
  CANCELLED: '#898781',
  REJECTED: '#d03b3b',
}

const assigned = new Map<string, string>()

/**
 * Stable series color: known channels get their mandated hue; anything else is
 * assigned the next categorical slot on first sight and keeps it for the session
 * (so filtering never repaints survivors).
 */
export function seriesColor(key: string): string {
  const known = CHANNEL_COLORS[key]
  if (known) return known
  let c = assigned.get(key)
  if (!c) {
    c = CATEGORICAL[assigned.size % CATEGORICAL.length]
    assigned.set(key, c)
  }
  return c
}

/** Chart chrome tokens (light surface). */
export const CHROME = {
  surface: '#ffffff',
  gridline: '#eef0f4',
  axisLine: '#d5d9e0',
  axisLabel: '#898781',
  legendText: '#52514e',
} as const
