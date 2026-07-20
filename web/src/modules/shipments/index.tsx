import { DeliveryTrend } from './DeliveryTrend'
import { LateIssues } from './LateIssues'
import { MetricsExplorer } from './MetricsExplorer'
import { OnTimeKpis } from './OnTimeKpis'
import { OnTimeTrend } from './OnTimeTrend'
import { TimingDistribution } from './TimingDistribution'
import { WorstPerformers } from './WorstPerformers'

/**
 * Module A — Shipment Analytics.
 * A1: configurable Metrics Explorer (cohort toggle lives in the global filter bar).
 * A2: on-time & ship-timing — KPI cards, trend, distribution, worst performers.
 */
export default function ShipmentsPage() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <MetricsExplorer />
      </section>

      <section className="space-y-3">
        <h2 className="label-xs !text-[12px]">On-Time &amp; Ship Timing</h2>
        <OnTimeKpis />
        <div className="grid gap-3 xl:grid-cols-2">
          <OnTimeTrend />
          <TimingDistribution />
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          <LateIssues />
          <DeliveryTrend />
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          <WorstPerformers />
        </div>
      </section>
    </div>
  )
}
