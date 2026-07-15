function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[], columns?: string[]): void {
  if (!rows.length) return
  const cols = columns ?? Object.keys(rows[0])
  const lines = [cols.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row[c])).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  triggerDownload(URL.createObjectURL(blob), filename.endsWith('.csv') ? filename : `${filename}.csv`)
}

export function downloadPng(dataUrl: string, filename: string): void {
  triggerDownload(dataUrl, filename.endsWith('.png') ? filename : `${filename}.png`)
}

function triggerDownload(href: string, download: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = download
  document.body.appendChild(a)
  a.click()
  a.remove()
}
