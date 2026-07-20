import { useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  text: string
  /** Applied to the truncated inline span. */
  className?: string
}

/**
 * Truncated text that reveals the full content in a floating panel on hover.
 * Rendered through a portal with fixed positioning so table/modal overflow
 * can't clip it; pointer-events are disabled on the panel to avoid flicker.
 */
export function HoverReveal({ text, className = 'block max-w-[30rem] truncate' }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const v = text.trim()
  if (!v) return <span className="text-faint">—</span>
  return (
    <>
      <span
        className={`${className} cursor-help`}
        onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setPos(null)}
      >
        {v}
      </span>
      {pos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[70] max-w-md overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-white p-3 text-[12.5px] leading-snug shadow-2xl"
            style={{
              left: Math.min(pos.x + 14, Math.max(8, window.innerWidth - 460)),
              top: Math.min(pos.y + 14, Math.max(8, window.innerHeight - 320)),
              maxHeight: 300,
            }}
          >
            {v}
          </div>,
          document.body,
        )}
    </>
  )
}
