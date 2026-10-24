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

// 文中输入框(当前用于评论):键盘只会缩小 visualViewport,iPad 横屏下表单又常常靠近
// 页面底部。这里在表单后临时留出键盘高度的滚动余量,再把输入行滚到可视区域,避免把
// 整个评论表单改成 fixed 浮动层而破坏正文流。
export function attachInlineInputViewport(form, input) {
  const viewport = window.visualViewport
  const scroller = document.scrollingElement || document.documentElement
  let frame = 0
  let disposed = false

  function clearSpace() {
    form.classList.remove('keyboard-open')
    form.style.setProperty('--comment-keyboard-space', '0px')
  }

  function sync() {
    frame = 0
    if (disposed) return
    const height = viewport?.height || window.innerHeight
    const offset = viewport?.offsetTop || 0
    const unzoomed = !viewport || Math.abs(viewport.scale - 1) < .05
    const keyboardInset = Math.max(0, window.innerHeight - height - offset)
    const compact = unzoomed && (keyboardInset > 120 || height < 520)
    const focused = document.activeElement === input

    if (!compact || !focused) {
      clearSpace()
      return
    }

    const reserve = Math.min(Math.round(window.innerHeight * .6), keyboardInset || Math.round(height * .55))
    form.style.setProperty('--comment-keyboard-space', `${reserve}px`)
    form.classList.add('keyboard-open')

    const bounds = input.getBoundingClientRect()
    const top = offset + 8
    const bottom = offset + height - 8
    let delta = 0
    if (bounds.bottom > bottom) delta = bounds.bottom - bottom
    else if (bounds.top < top) delta = bounds.top - top
    // 直接改 scrollingElement.scrollTop,绕过 html { scroll-behavior: smooth };
    // 键盘动画期间再叠一段平滑滚动会让输入框短暂继续停在键盘后面。
    if (delta) {
      if (scroller) {
        const previousBehavior = scroller.style?.scrollBehavior
        if (scroller.style) scroller.style.scrollBehavior = 'auto'
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + delta + (delta > 0 ? 8 : 0))
        if (scroller.style) scroller.style.scrollBehavior = previousBehavior || ''
      } else {
        window.scrollBy?.(0, delta + (delta > 0 ? 8 : 0))
      }
    }
  }

  function schedule() {
    if (!frame && !disposed) frame = requestAnimationFrame(sync)
  }

  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  input.addEventListener('focus', schedule)
  input.addEventListener('blur', schedule)
  sync()
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    frame = 0
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    input.removeEventListener('focus', schedule)
    input.removeEventListener('blur', schedule)
    clearSpace()
  }
}
