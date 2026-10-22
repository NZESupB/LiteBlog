import { useRef, useState } from 'react'
export function Archive({
  months,
  active,
  onPick,
}: {
  months: { month: string; count: number }[]
  active: string
  onPick: (month: string) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const drag = useRef<{ start: string; current: string; moved: boolean } | null>(null)
  const [preview, setPreview] = useState('')
  if (months.length < 2) return null
  const title = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`
  return (
    <>
      <nav className="archive-outline" aria-label="按月归档">
        {months.map(({ month, count }, index) => (
          <div key={month}>
            {(!index || months[index - 1].month.slice(0, 4) !== month.slice(0, 4)) && (
              <h3>{month.slice(0, 4)}</h3>
            )}
            <button
              className={active === month ? 'here' : ''}
              aria-current={active === month ? 'date' : undefined}
              onClick={() => onPick(month)}
            >
              <span>{Number(month.slice(5))}月</span>
              <span>{count}</span>
            </button>
          </div>
        ))}
      </nav>
      <nav
        ref={ref}
        className="archive-rail"
        aria-label="拖动跳转月份"
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => {
          const month = (event.target as HTMLElement).closest<HTMLElement>('[data-month]')?.dataset.month
          if (!month) return
          drag.current = { start: month, current: month, moved: false }
          setPreview(month)
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* 指针已结束时不捕获。 */
          }
        }}
        onPointerMove={(event) => {
          if (!drag.current || !ref.current) return
          const buttons = [...ref.current.querySelectorAll<HTMLElement>('[data-month]')]
          const nearest = buttons.reduce(
            (best, node) =>
              Math.abs(node.getBoundingClientRect().top + node.offsetHeight / 2 - event.clientY) <
              Math.abs(best.getBoundingClientRect().top + best.offsetHeight / 2 - event.clientY)
                ? node
                : best,
            buttons[0],
          )
          const month = nearest?.dataset.month
          if (month) {
            drag.current.current = month
            drag.current.moved ||= month !== drag.current.start
            setPreview(month)
          }
        }}
        onPointerUp={() => {
          if (drag.current) onPick(drag.current.current)
          drag.current = null
          setPreview('')
        }}
        onPointerCancel={() => {
          drag.current = null
          setPreview('')
        }}
      >
        {months.map(({ month }) => (
          <button
            key={month}
            data-month={month}
            aria-label={title(month)}
            className={active === month ? 'here' : ''}
            onClick={(event) => {
              if (event.detail === 0) onPick(month)
            }}
          >
            <span aria-hidden="true">—</span>
          </button>
        ))}
      </nav>
      {preview && (
        <div className="archive-bubble" role="status">
          {title(preview)}
        </div>
      )}
    </>
  )
}
