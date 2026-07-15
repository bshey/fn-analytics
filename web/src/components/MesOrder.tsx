import { Link } from 'react-router-dom'

/**
 * Order identity, app-wide convention (owner decision): show the INTERNAL
 * number — the last 5 digits of the MSB id (= the fcm order id) — never the
 * FN- number. Order numbers link to the MES page in a new tab.
 */

export function orderShortNo(internalDisplayId: unknown, id?: unknown): string {
  const m = String(internalDisplayId ?? '').match(/(\d{5})\s*$/)
  if (m) return m[1]
  const idStr = String(id ?? '')
  return idStr && idStr !== 'undefined' && idStr !== 'null' ? idStr : String(internalDisplayId ?? '—')
}

export function mesOrderUrl(shortNo: string): string {
  return `https://fcm-mes.formlabs.com/orders/${shortNo}`
}

/** Deep-link to the in-app order deep-dive, preserving the global filter params. */
export function deepDiveLink(q: string): string {
  const sp = new URLSearchParams(window.location.search)
  sp.set('q', q)
  return `/orders?${sp.toString()}`
}

interface Props {
  internalDisplayId: unknown
  id?: unknown
  /** Also render a small in-app "details" link to the deep-dive. */
  details?: boolean
}

/** Order number linking to the MES page (new tab), optional in-app details link. */
export function MesOrder({ internalDisplayId, id, details }: Props) {
  const no = orderShortNo(internalDisplayId, id)
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <a
        href={mesOrderUrl(no)}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-accent hover:underline"
        onClick={(e) => e.stopPropagation()}
        title={`Open ${String(internalDisplayId ?? no)} in MES`}
      >
        {no}
        <span aria-hidden className="ml-0.5 align-super text-[9px]">↗</span>
      </a>
      {details && (
        <Link
          to={deepDiveLink(String(internalDisplayId ?? no))}
          className="text-[11px] text-faint hover:text-accent hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          details
        </Link>
      )}
    </span>
  )
}
