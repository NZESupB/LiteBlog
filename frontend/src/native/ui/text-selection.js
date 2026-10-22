// 保留 textarea/input 原生撤销栈，浏览器不支持时显式派发 input。
export function replaceSelection(input, text) {
  input.focus({ preventScroll: true })
  try {
    if (document.execCommand?.('insertText', false, text)) return
  } catch {}
  input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end')
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
