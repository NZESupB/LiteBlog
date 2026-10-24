import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Info } from 'lucide-react'

/** 长文案的悬浮说明：桌面 hover、触屏点击/长按、键盘聚焦都能打开，Escape/外部点击收起。 */
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const pressTimer = useRef(0)
  const longPressed = useRef(false)
  const pointerKind = useRef('')
  const hoverOpen = useRef(false)
  const tooltipId = `hint-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => () => window.clearTimeout(pressTimer.current), [])

  const cancelPress = () => {
    window.clearTimeout(pressTimer.current)
    pressTimer.current = 0
  }
  const startPress = (event: PointerEvent<HTMLButtonElement>) => {
    longPressed.current = false
    pointerKind.current = event.pointerType
    if (event.pointerType === 'mouse') return
    cancelPress()
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      setOpen(true)
    }, 350)
  }

  return (
    <div
      className={`info-hint${open ? ' is-open' : ''}`}
      ref={root}
      onPointerEnter={(event) => {
        pointerKind.current = event.pointerType
        if (event.pointerType === 'mouse') {
          hoverOpen.current = true
          setOpen(true)
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          hoverOpen.current = false
          setOpen(false)
        }
        cancelPress()
      }}
    >
      <button
        type="button"
        className="info-hint-button"
        aria-label={`${label}说明`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false
            return
          }
          // 桌面端 hover 已打开，点击不再反向收起；离开/Escape 负责关闭。
          if (pointerKind.current === 'mouse' && hoverOpen.current) return
          setOpen((value) => !value)
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) setOpen(true)
        }}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
        onPointerDown={startPress}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          if (longPressed.current) event.preventDefault()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            event.currentTarget.blur()
          }
        }}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      <div className="info-hint-pop" id={tooltipId} role="tooltip" aria-hidden={!open}>
        {children}
      </div>
    </div>
  )
}
