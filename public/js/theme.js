// 在样式表加载前恢复本机外观,避免刷新时闪回默认配色。
// 只有明暗两套语义色:强调色固定为玫瑰粉,不再维护多套配色(维护成本高于收益)。
// system 用 matchMedia 实时跟随系统,系统切换时立即重画,不需要刷新。
(() => {
  const key = 'journal-theme'
  const choices = [
    { id: 'system', name: '跟随系统' },
    { id: 'light', name: '浅色' },
    { id: 'dark', name: '深色' },
  ]
  // 浏览器界面(状态栏/地址栏)颜色,随明暗切换
  const chromeColor = { light: '#fff8fa', dark: '#000000' }
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  const normalize = (id) => choices.find((choice) => choice.id === id) || choices[0]
  const resolve = (id) => (id === 'system' ? (query?.matches ? 'dark' : 'light') : id)

  function apply(id, persist = false) {
    const choice = normalize(id)
    const scheme = resolve(choice.id)
    document.documentElement.dataset.theme = scheme
    document.documentElement.dataset.themePreference = choice.id
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chromeColor[scheme])
    let saved = true
    if (persist) {
      try { localStorage.setItem(key, choice.id) } catch { saved = false }
    }
    window.dispatchEvent(new Event('journal-theme-change'))
    return saved
  }

  let initial = 'system'
  try { initial = localStorage.getItem(key) } catch {}
  // 早期版本存的是 pink/blue/cream:配色已收敛,静默回落到跟随系统
  apply(initial)
  window.JournalTheme = {
    choices,
    get current() { return document.documentElement.dataset.theme || 'light' },
    get preference() { return document.documentElement.dataset.themePreference || 'system' },
    set: (id) => apply(id, true),
  }
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) apply(event.newValue)
  })
  // 跟随系统时,系统在明暗之间切换(或按日出日落自动切换)要即时生效
  query?.addEventListener?.('change', () => {
    if (window.JournalTheme.preference === 'system') apply('system')
  })
})()
