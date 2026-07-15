import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart, HeatmapChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { CATEGORICAL, CHROME } from './palette'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
])

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

echarts.registerTheme('fn', {
  color: [...CATEGORICAL],
  textStyle: { fontFamily: FONT },
  categoryAxis: {
    axisLine: { lineStyle: { color: CHROME.axisLine } },
    axisTick: { show: false },
    axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
    splitLine: { lineStyle: { color: CHROME.gridline, type: 'solid' } },
  },
  legend: {
    textStyle: { color: CHROME.legendText, fontSize: 11.5 },
    itemWidth: 12,
    itemHeight: 8,
    icon: 'roundRect',
  },
  tooltip: {
    backgroundColor: '#ffffff',
    borderColor: '#eceef2',
    borderWidth: 1,
    textStyle: { color: '#1a1f2b', fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 16px rgba(16,24,40,.08); border-radius: 8px;',
  },
})

export { echarts }

/** Mark-spec defaults: thin bars, 4px rounded data-end, 2px surface gap between stacked fills. */
export const barDefaults = {
  type: 'bar' as const,
  barMaxWidth: 24,
  itemStyle: { borderRadius: [3, 3, 0, 0] as [number, number, number, number] },
}

export const stackedBarDefaults = {
  type: 'bar' as const,
  barMaxWidth: 28,
  itemStyle: { borderColor: '#ffffff', borderWidth: 1 },
}

export const lineDefaults = {
  type: 'line' as const,
  symbol: 'circle' as const,
  symbolSize: 7,
  lineStyle: { width: 2 },
  itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
}

export const gridDefaults = {
  left: 8,
  right: 12,
  top: 36,
  bottom: 4,
  containLabel: true,
}
