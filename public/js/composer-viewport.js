// 手机键盘通常只缩小可视视口，不改变 fixed 元素所用的布局视口。
export function attachComposerViewport(overlay) {
  const viewport = window.visualViewport
  const scroller = overlay.querySelector('.composer-body')
  let frame = 0
  let disposed = false

  function sync() {
    frame = 0
    if (disposed) return
    const height = viewport?.height || window.innerHeight
    const offset = viewport?.offsetTop || 0
    overlay.style.setProperty('--composer-viewport-height', `${height}px`)
    overlay.style.setProperty('--composer-viewport-top', `${offset}px`)
    const unzoomed = !viewport || Math.abs(viewport.scale - 1) < .05
    const compact = unzoomed && (window.innerHeight - height > 120 || height < 520)
    overlay.classList.toggle('keyboard-open', compact)

    const focused = document.activeElement
    if (!compact || !scroller.contains(focused) || !focused.matches('textarea, input, select')) return
    const bounds = scroller.getBoundingClientRect()
    const input = focused.getBoundingClientRect()
    const top = Math.max(bounds.top, offset) + 8
    const bottom = Math.min(bounds.bottom, offset + height) - 8
    if (input.top < top) scroller.scrollTop += input.top - top
    else if (input.bottom > bottom) scroller.scrollTop += Math.min(input.bottom - bottom, input.top - top)
  }
  function schedule() {
    if (!frame && !disposed) frame = requestAnimationFrame(sync)
  }
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  overlay.addEventListener('focusin', schedule)
  sync()
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    overlay.removeEventListener('focusin', schedule)
  }
}
