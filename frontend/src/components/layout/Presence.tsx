import { useEffect, useRef, useState, type ReactNode } from 'react'
import { animatePresence, disposeAnimations } from '../../native/ui/motion.js'

// React 管节点，Motion 管显隐；退出结束后才让 React 卸载子树。
export function Presence({
  open,
  className = '',
  preset = 'menu-presence',
  children,
  ...props
}: {
  open: boolean
  className?: string
  preset?: string
  children: ReactNode
  onClick?: React.MouseEventHandler<HTMLDivElement>
  role?: string
  id?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open && !mounted) {
      setMounted(true)
      return
    }
    const node = ref.current
    if (!node) return
    let active = true
    void animatePresence(node, open, { className: preset, hidden: false }).then(
      (result: { status: string }) => {
        if (active && !open && result.status === 'finished') setMounted(false)
      },
    )
    return () => {
      active = false
      disposeAnimations(node)
    }
  }, [open, mounted, preset])
  return mounted ? (
    <div ref={ref} className={className} {...props}>
      {children}
    </div>
  ) : null
}
