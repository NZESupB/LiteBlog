// 在样式表加载前恢复本机主题，避免刷新时闪回默认配色。
(() => {
  const key = 'journal-theme'
  const choices = [
    { id: 'pink', name: '樱花粉', color: '#a54363' },
    { id: 'blue', name: '雾蓝', color: '#376589' },
    { id: 'cream', name: '奶油白', color: '#86623f' },
  ]
  const normalize = (id) => choices.find((choice) => choice.id === id) || choices[0]
  function apply(id, persist = false) {
    const choice = normalize(id)
    document.documentElement.dataset.theme = choice.id
    document.querySelector('meta[name="theme-color"]').content = choice.color
    let saved = true
    if (persist) {
      try { localStorage.setItem(key, choice.id) } catch { saved = false }
    }
    window.dispatchEvent(new Event('journal-theme-change'))
    return saved
  }
  let initial = 'pink'
  try { initial = localStorage.getItem(key) } catch {}
  apply(initial)
  window.JournalTheme = {
    choices,
    get current() { return document.documentElement.dataset.theme },
    set: (id) => apply(id, true),
  }
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) apply(event.newValue)
  })
})()
