// Markdown 工具栏(自实现,零依赖)
// 通过 data-md 声明操作类型;选区包裹/行前缀/光标处插入,尽量保留撤销栈(execCommand),失败回退 setRangeText
const $ = (s, el) => el.querySelector(s)

// 在保留原生撤销栈的前提下替换选区内容;不支持时回退 setRangeText
function replaceSelection(ta, text) {
  ta.focus()
  try {
    // execCommand 虽废弃但仍是最可靠保留 undo 栈的方式
    if (document.execCommand && document.execCommand('insertText', false, text)) return
  } catch {}
  const { selectionStart: s, selectionEnd: e, value } = ta
  ta.setRangeText(text, s, e, 'end')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

// 选区两侧包裹标记;再次触发同标记时取消包裹
function wrapSelection(ta, before, after = before, placeholder = '') {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const sel = value.slice(s, e) || placeholder
  const already = value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after
  if (already) {
    ta.setRangeText(sel, s - before.length, e + after.length, 'select')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  replaceSelection(ta, before + sel + after)
  ta.setSelectionRange(s + before.length, s + before.length + sel.length)
}

// 对选区覆盖到的每一行加/去前缀;前缀可为字符串或按行号生成(有序列表)
function prefixLines(ta, prefix, ordered = false) {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const start = value.lastIndexOf('\n', s - 1) + 1
  const end = value.indexOf('\n', e)
  const block = value.slice(start, end === -1 ? value.length : end)
  const lines = block.split('\n')
  const testRe = ordered ? /^\d+\.\s/ : new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const has = lines.every((l) => l.trim() === '' || testRe.test(l))
  const next = lines
    .map((l, i) => {
      if (l.trim() === '') return l
      if (has) return l.replace(testRe, '')
      return (ordered ? `${i + 1}. ` : prefix) + l
    })
    .join('\n')
  ta.setRangeText(next, start, end === -1 ? value.length : end, 'select')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

function insertBlock(ta, text) {
  const { selectionStart: s, value } = ta
  const atLineStart = s === 0 || value[s - 1] === '\n'
  replaceSelection(ta, (atLineStart ? '' : '\n') + text)
}

function promptLink(ta) {
  const { selectionStart: s, selectionEnd: e, value } = ta
  const sel = value.slice(s, e) || '链接文字'
  const url = prompt('链接地址 (https://…)')
  if (!url) return
  replaceSelection(ta, `[${sel}](${url})`)
  ta.setSelectionRange(s + 1, s + 1 + sel.length)
}

const ACTIONS = {
  bold: (ta) => wrapSelection(ta, '**', '**', '加粗'),
  italic: (ta) => wrapSelection(ta, '*', '*', '斜体'),
  strikethrough: (ta) => wrapSelection(ta, '~~', '~~'),
  heading: (ta) => prefixLines(ta, '### '),
  quote: (ta) => prefixLines(ta, '> '),
  'code-inline': (ta) => wrapSelection(ta, '`', '`', '代码'),
  'code-block': (ta) => wrapSelection(ta, '\n```\n', '\n```\n', '代码块'),
  link: promptLink,
  'list-ul': (ta) => prefixLines(ta, '- '),
  'list-ol': (ta) => prefixLines(ta, '', true),
  tasklist: (ta) => prefixLines(ta, '- [ ] '),
}

export function attachMdToolbar(toolbar, textarea) {
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md]')
    if (!btn) return
    e.preventDefault()
    ACTIONS[btn.dataset.md]?.(textarea)
  })
  // 快捷键:Cmd/Ctrl+B 加粗,Cmd/Ctrl+I 斜体,Cmd/Ctrl+K 链接
  textarea.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const map = { b: 'bold', i: 'italic', k: 'link' }
    const action = map[e.key.toLowerCase()]
    if (!action) return
    e.preventDefault()
    ACTIONS[action](textarea)
  })
}
