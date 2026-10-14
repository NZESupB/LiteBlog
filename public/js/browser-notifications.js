// 浏览器通知的共享状态与 Web Push 生命周期，所有入口使用同一份快照。
export function createBrowserNotifications({ api, getRegistration, getUser, win = window, doc = document, nav = navigator, readyTimeoutMs = 5000 }) {
  const listeners = new Set()
  let revision = 0
  let query = null
  let operation = null
  let channel = null
  let stopListening = null

  function environment() {
    if (!win.isSecureContext) return { supported: false, label: '通知需要 HTTPS', help: '请使用 HTTPS 地址打开此站点。' }
    const ios = /iPad|iPhone|iPod/.test(nav.platform) || (nav.maxTouchPoints > 1 && /Mac/.test(nav.platform))
    const standalone = win.matchMedia?.('(display-mode: standalone)').matches || nav.standalone
    if (ios && !standalone) return { supported: false, label: '请添加到主屏幕后开启', help: 'iPhone 请从分享菜单添加到主屏幕，再从主屏幕打开此站点。' }
    if (!('Notification' in win) || !('PushManager' in win) || !('serviceWorker' in nav)) {
      return { supported: false, label: '浏览器不支持通知', help: '请更新浏览器，或使用支持 Web Push 的浏览器。' }
    }
    return { supported: true, help: '允许后，另一位成员发表评论时会提醒你。' }
  }

  function browserState() {
    return { supported: environment().supported, permission: win.Notification?.permission || 'default' }
  }

  function describe(value) {
    const current = environment()
    let label = '开启浏览器通知'
    let help = current.help
    if (!value.supported) label = current.label
    else if (value.busy) { label = '处理中…'; help = '正在更新浏览器通知状态。' }
    else if (value.permission === 'denied') {
      label = '通知权限已被阻止'
      help = '请在浏览器的站点设置中允许通知，再回到这里重试。'
    } else if (value.subscribed === null) {
      label = value.error ? '通知暂时不可用' : '检查通知状态…'
    } else if (value.permission === 'granted' && value.subscribed) {
      label = '关闭浏览器通知'
      help = '已开启。另一位成员发表评论时会提醒你。'
    }
    return Object.freeze({ ...value, label, help: value.error || help })
  }

  let state = describe({ ...browserState(), subscribed: null, busy: false, error: null })
  function publish(patch) {
    state = describe({ ...state, ...patch })
    for (const listener of listeners) listener(state)
  }

  async function registration() {
    let timer
    try {
      const result = await Promise.race([
        Promise.resolve(getRegistration()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('通知服务尚未就绪，请稍后重试。')), readyTimeoutMs) }),
      ])
      if (!result?.pushManager) throw new Error('通知服务尚未就绪，请稍后重试。')
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async function readState() {
    const current = browserState()
    if (!current.supported || current.permission === 'denied') return { ...current, subscribed: false }
    const subscribed = Boolean(await (await registration()).pushManager.getSubscription())
    // 授权框或浏览器设置可能在异步查询期间改变权限。
    const latest = browserState()
    return { ...latest, subscribed: latest.permission === 'granted' && subscribed }
  }

  function refresh() {
    if (operation) return operation.catch(() => state)
    if (query) return query
    const version = revision
    const pending = readState().then((next) => {
      if (version !== revision) return state
      const changed = next.permission !== state.permission || next.subscribed !== state.subscribed || next.supported !== state.supported
      publish({ ...next, error: changed ? null : state.error })
      return state
    }, (error) => {
      if (version === revision) publish({ ...browserState(), subscribed: null, error: error.message || '无法读取通知状态，请稍后重试。' })
      return state
    }).finally(() => { if (query === pending) query = null })
    query = pending
    return pending
  }

  function runOperation(action) {
    if (operation) return operation
    // 先占用操作槽，再调用 action；权限请求仍在点击的同步调用链中。
    let resolveOperation
    let rejectOperation
    const pending = new Promise((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject })
    operation = pending
    revision++
    query = null
    publish({ busy: true, error: null })
    void (async () => {
      let failure = null
      try { await action() } catch (error) { failure = error }
      let next
      try { next = await readState() } catch (error) {
        next = { ...browserState(), subscribed: null }
        failure ||= error
      }
      operation = null
      publish({ ...next, busy: false, error: failure ? (failure.message || '无法更新通知，请稍后重试。') : null })
      channel?.postMessage({ type: 'notifications-changed' })
      if (failure) rejectOperation(failure)
      else resolveOperation(state)
    })()
    return pending
  }

  function saveSubscription(subscription) {
    return api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
  }

  async function unsubscribe(subscription) {
    if (!await subscription.unsubscribe()) throw new Error('浏览器未能关闭通知订阅，请重试。')
  }

  async function enable() {
    const worker = await registration()
    const existing = await worker.pushManager.getSubscription()
    if (existing) { await saveSubscription(existing); return }
    const { key } = await api('/api/push/key')
    const base64 = key.replace(/-/g, '+').replace(/_/g, '/')
    const raw = win.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(raw, (ch) => ch.charCodeAt(0)),
    })
    try { await saveSubscription(subscription) } catch (error) {
      // 服务端未保存时撤销本地订阅；回滚也失败则同时暴露两次失败。
      try { await unsubscribe(subscription) } catch (rollbackError) {
        throw new Error(`${error.message}；撤销本地订阅失败：${rollbackError.message}`)
      }
      throw error
    }
  }

  async function removeSubscription(subscription) {
    let failure = null
    try {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      })
    } catch (error) { failure = error }
    // 服务端失败仍尝试本地退订，避免设备继续接收旧账户通知。
    try { await unsubscribe(subscription) } catch (error) {
      failure = failure ? new Error(`${failure.message}；${error.message}`) : error
    }
    if (failure) throw failure
  }

  function toggle() {
    return runOperation(async () => {
      const current = environment()
      if (!current.supported) throw new Error(current.help)
      if (!getUser()) throw new Error('请先登录后开启通知。')
      // default 权限必须在任何异步订阅查询之前申请，保留移动端用户手势。
      if (win.Notification.permission === 'default') {
        const permission = await win.Notification.requestPermission()
        if (permission !== 'granted') throw new Error('未获得通知权限，可在浏览器站点设置中重新允许。')
        await enable()
        return
      }
      if (win.Notification.permission === 'denied') throw new Error('请在浏览器的站点设置中允许通知，再回到这里重试。')
      const subscription = await (await registration()).pushManager.getSubscription()
      if (subscription) await removeSubscription(subscription)
      else await enable()
    })
  }

  function autoEnable() {
    if (!getUser() || !environment().supported || win.Notification.permission === 'denied') return refresh()
    return runOperation(async () => {
      const subscription = await (await registration()).pushManager.getSubscription()
      // 已有订阅也需要绑定当前登录账户；初始化不请求未决定的权限。
      if (subscription) await saveSubscription(subscription)
      else if (win.Notification.permission === 'granted') await enable()
    })
  }

  function disable() {
    // 退出登录必须在正在进行的开启操作结束之后真正退订。
    if (operation) return operation.catch(() => {}).then(disable)
    if (!environment().supported) return Promise.resolve(state)
    return runOperation(async () => {
      const subscription = await (await registration()).pushManager.getSubscription()
      if (subscription) await removeSubscription(subscription)
    })
  }

  function start() {
    if (stopListening) return stopListening
    let active = true
    let permissionStatus = null
    const onRefresh = () => {
      // 外部事件表示浏览器状态可能已变，不能复用事件发生前的查询。
      if (!operation) { revision++; query = null }
      void refresh()
    }
    const onVisible = () => { if (doc.visibilityState === 'visible') onRefresh() }
    win.addEventListener('focus', onRefresh)
    win.addEventListener('pageshow', onRefresh)
    doc.addEventListener('visibilitychange', onVisible)
    if (nav.permissions?.query) {
      nav.permissions.query({ name: 'notifications' }).then((status) => {
        if (!active) return
        permissionStatus = status
        status.addEventListener('change', onRefresh)
        onRefresh()
      }).catch(() => { /* 部分浏览器不支持 notifications 权限查询，页面恢复时仍会刷新。 */ })
    }
    if (win.BroadcastChannel) {
      channel = new win.BroadcastChannel('browser-notifications')
      channel.onmessage = (event) => { if (event.data?.type === 'notifications-changed') onRefresh() }
    }
    stopListening = () => {
      active = false
      win.removeEventListener('focus', onRefresh)
      win.removeEventListener('pageshow', onRefresh)
      doc.removeEventListener('visibilitychange', onVisible)
      permissionStatus?.removeEventListener('change', onRefresh)
      channel?.close()
      channel = null
      stopListening = null
    }
    onRefresh()
    return stopListening
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    refresh, toggle, autoEnable, disable, start,
  }
}
