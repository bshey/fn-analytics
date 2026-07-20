import { NavLink, Outlet } from 'react-router-dom'
import { useHealth, useNamedQuery } from '../lib/api'
import { fmtDate } from '../lib/format'
import { FilterBar } from './FilterBar'

const NAV = [
  {
    to: '/shipments',
    label: 'Shipments',
    icon: <path d="M1 4h10v8H1zM11 7h3l1 2v3h-4zM4 12.5a1.2 1.2 0 1 0 0 .01M12 12.5a1.2 1.2 0 1 0 0 .01" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />,
  },
  {
    to: '/wip',
    label: 'Throughput & WIP',
    icon: <path d="M2 13V8M6 13V3M10 13V6M14 13V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  },
  {
    to: '/orders',
    label: 'Problem Order Triage',
    icon: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />,
  },
  {
    to: '/floor',
    label: 'Floor & Operators',
    icon: <path d="M2 14V7l4-3 4 3v7M6 14v-4h0M12 14V9l2-1.5V14M2 14h13" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" />,
  },
  {
    to: '/predictor',
    label: 'Ship Predictor',
    icon: <path d="M8 2v3M8 5a5 5 0 1 0 5 5M13 3l-5 7" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  },
  {
    to: '/cs',
    label: 'Customer Service',
    icon: <path d="M2 3h12v8H8l-3 3v-3H2zM5 6.5h6M5 8.5h4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  },
]

export function Layout() {
  const health = useHealth()
  const freshness = useNamedQuery('meta_freshness', {})
  const latestShip = freshness.data?.rows?.[0]?.latest_ship_date as string | undefined

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-52 flex-col border-r border-line bg-white">
        <div className="px-4 pb-3 pt-4">
          <div className="text-[15px] font-bold tracking-tight">
            Form Now <span className="text-accent">Ops</span>
          </div>
          <div className="text-[11px] text-faint">production analytics</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
                  isActive ? 'bg-accent/8 font-medium text-accent' : 'text-sub hover:bg-page hover:text-ink'
                }`
              }
            >
              <svg width="15" height="15" viewBox="0 0 16 16">{n.icon}</svg>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-4 pb-4 text-[11px] text-faint">
          {health.data && !health.data.mock && !health.data.hasApiKey && (
            <div className="rounded-md border border-bad/30 bg-red-50 px-2 py-1 text-bad">
              REDASH_API_KEY not set — see .env.example
            </div>
          )}
          <div>
            {latestShip ? `Data as of ${fmtDate(latestShip)}` : 'Freshness unknown'} · warehouse lags ~1 day
          </div>
        </div>
      </aside>

      <div className="ml-52 flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-10">
          {health.data?.mock && (
            <div className="bg-amber-400 px-5 py-1.5 text-center text-[12.5px] font-semibold text-black">
              DEMO DATA — server is running in mock mode (MOCK=1); every number on every page is synthetic.
              Restart with <code className="rounded bg-black/10 px-1">npm start</code> for live data.
            </div>
          )}
          <FilterBar />
        </div>
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-5 py-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
