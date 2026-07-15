import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ECharts } from 'echarts/core'
import { echarts } from '../lib/echarts'

export interface EChartHandle {
  getPngDataUrl(): string | undefined
  getInstance(): ECharts | undefined
}

interface Props {
  option: Record<string, unknown>
  height?: number
  onClick?: (params: unknown) => void
}

/** Thin ECharts wrapper: 'fn' theme, resize observer, PNG export via ref. */
export const EChart = forwardRef<EChartHandle, Props>(function EChart({ option, height = 340, onClick }, ref) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<ECharts>()

  useImperativeHandle(ref, () => ({
    getPngDataUrl: () => chart.current?.getDataURL({ pixelRatio: 2, backgroundColor: '#ffffff' }),
    getInstance: () => chart.current,
  }))

  useEffect(() => {
    if (!el.current) return
    const inst = echarts.init(el.current, 'fn', { renderer: 'canvas' })
    chart.current = inst
    const ro = new ResizeObserver(() => inst.resize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      inst.dispose()
      chart.current = undefined
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option as never, { notMerge: true })
  }, [option])

  useEffect(() => {
    const inst = chart.current
    if (!inst || !onClick) return
    inst.on('click', onClick)
    return () => {
      inst.off('click', onClick)
    }
  }, [onClick])

  return <div ref={el} style={{ height, width: '100%' }} />
})
