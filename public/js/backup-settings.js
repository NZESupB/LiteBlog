// 备份设置页：轮询只在本页存活期间运行，恢复成功后交给主应用清理会话与草稿。
import { api, el, esc, formatBytes, setFormMessage } from './utils.js'

export function createBackupSettings(onRestored) {
  const node = el(`<div class="backup-settings">
    <section class="settings-card">
      <div class="settings-card-heading"><div><h2>数据库备份</h2><p>备份到图片存储所配置的 WebDAV 目录，仅保留最新一份数据库。</p></div></div>
      <p class="backup-connection storage-status" role="status">正在读取备份状态…</p>
      <form class="backup-config">
        <fieldset class="backup-fields" disabled>
          <label class="row"><input type="checkbox" name="enabled" /><span>每天自动备份</span></label>
          <label>每日备份时间（北京时间）<input type="time" name="time" required value="03:30" /></label>
          <p class="storage-hint">服务运行时自动执行；重新启动后会补执行当天错过的备份。当天手动备份成功后，不再重复自动备份。</p>
          <div class="settings-actions"><button class="btn-ghost backup-now" type="button">立即备份</button><span class="spacer"></span><button class="btn" type="submit">保存定时设置</button></div>
        </fieldset>
      </form>
      <dl class="backup-status" aria-live="polite"><dt>当前状态</dt><dd class="backup-state">正在读取…</dd><dt>下次自动备份</dt><dd class="backup-next">—</dd><dt>上次备份</dt><dd class="backup-last">—</dd></dl>
      <p class="form-message backup-message" role="status" aria-live="polite"></p>
    </section>
    <section class="settings-card">
      <div class="settings-card-heading"><div><h2>导入数据库恢复</h2><p>选择本站备份的 .db 文件，整体替换当前数据库。</p></div></div>
      <p class="backup-warning">账号、密码、动态、评论、草稿、任务记录、通知订阅、站点设置和个人设置均以导入文件为准。恢复后，所有成员都需要重新登录。</p>
      <p class="storage-hint">图片、视频和头像不包含在 .db 中。现有媒体文件会保留原位，缺失文件需要另行补回。正在上传、处理视频或生成配图时，请先完成或取消任务。</p>
      <form class="backup-restore">
        <fieldset class="backup-restore-fields" disabled>
          <label>选择数据库文件<input type="file" name="file" accept=".db" required /></label>
          <p class="storage-hint backup-limit">正在读取文件大小上限…</p>
          <div class="settings-actions"><button class="btn-ghost backup-restore-button" type="submit">导入并恢复</button></div>
        </fieldset>
      </form>
      <p class="form-message restore-message" role="status" aria-live="polite"></p>
    </section>
  </div>`)
  const find = (selector) => node.querySelector(selector)
  const controller = new AbortController()
  let disposed = false, timer = null, data = null, initialized = false, working = false
  const alive = () => !disposed && node.isConnected
  const message = (selector, text, ok = false) => {
    if (!alive()) return
    const target = find(selector)
    setFormMessage(target, text, ok ? 'success' : 'error')
  }
  const timeLabel = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
  const render = () => {
    const busy = working || data.state !== 'idle'
    find('.backup-fields').disabled = busy
    find('.backup-restore-fields').disabled = busy
    find('.backup-now').disabled = busy || !data.webdavReady
    node.setAttribute('aria-busy', String(busy))
    find('.backup-connection').innerHTML = data.webdavReady
      ? `共用 WebDAV 目录：<strong>${esc(data.folder || '/')}</strong>`
      : '尚未配置完整的 WebDAV。请先到 <a href="#/settings/storage">图片存储</a> 设置连接；导入恢复仍可使用。'
    find('.backup-state').textContent = working ? '正在提交…' : data.state === 'backing-up' ? '正在生成快照并上传…' : data.state === 'restoring' ? '正在恢复…' : '就绪'
    find('.backup-next').textContent = data.nextRunAt ? `${timeLabel(data.nextRunAt)}（北京时间）` : data.enabled ? '等待配置 WebDAV' : '已关闭'
    const result = data.lastResult
    find('.backup-last').textContent = result
      ? `${timeLabel(result.finishedAt)} · ${result.ok ? '备份成功' : '备份失败'}${result.filename ? ` · ${result.filename}` : ''}${result.size ? ` · ${formatBytes(result.size)}` : ''}${result.error ? `：${result.error}` : ''}${result.warning ? `；${result.warning}` : ''}`
      : '暂无备份记录'
    find('.backup-limit').textContent = `文件上限 ${formatBytes(data.maxImportBytes)}。恢复前会在服务的数据目录内保留当前数据库副本。`
    if (!initialized) {
      find('[name=enabled]').checked = data.enabled
      find('[name=time]').value = data.time
      initialized = true
    }
  }
  const refresh = async () => {
    clearTimeout(timer)
    try {
      const state = await api('/api/backups', { signal: controller.signal })
      if (!alive()) return
      data = state
      render()
    } catch (error) {
      if (!alive() || error.name === 'AbortError') return
      message('.backup-message', `状态读取失败：${error.message}`)
    } finally {
      if (alive() && !working) timer = setTimeout(refresh, data?.state === 'backing-up' ? 1500 : 10000)
    }
  }
  find('.backup-config').onsubmit = async (event) => {
    event.preventDefault()
    if (working || !data || data.state !== 'idle') return
    working = true
    render()
    message('.backup-message', '')
    try {
      data = await api('/api/backups/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: find('[name=enabled]').checked, time: find('[name=time]').value }) })
      message('.backup-message', '定时设置已保存', true)
    } catch (error) { message('.backup-message', error.message) }
    finally { working = false; if (alive()) { render(); refresh() } }
  }
  find('.backup-now').onclick = async () => {
    if (working || !data || data.state !== 'idle') return
    working = true
    render()
    message('.backup-message', '')
    try {
      data = await api('/api/backups', { method: 'POST' })
      message('.backup-message', '备份已开始，可以离开此页面；结果会保存在服务中。', true)
    } catch (error) { message('.backup-message', error.message) }
    finally { working = false; if (alive()) { render(); refresh() } }
  }
  find('.backup-restore').onsubmit = async (event) => {
    event.preventDefault()
    if (working || !data || data.state !== 'idle') return
    const file = find('[name=file]').files[0]
    if (!file || !file.size || !/\.db$/i.test(file.name)) return message('.restore-message', '请选择一个非空的 .db 文件')
    if (file.size > data.maxImportBytes) return message('.restore-message', `文件不能超过 ${formatBytes(data.maxImportBytes)}`)
    if (!window.confirm(`确定用“${file.name}”整体替换当前数据库吗？\n\n当前账号、密码、动态、评论、草稿、任务记录、通知订阅、站点设置和个人设置将全部被替换。图片、视频和头像保留原位。恢复前保留数据库副本；恢复后请使用导入库中的账号重新登录。`)) return
    working = true
    clearTimeout(timer)
    render()
    find('.backup-state').textContent = '正在上传并校验数据库…'
    find('.backup-restore-button').textContent = '正在恢复…'
    message('.restore-message', '')
    const form = new FormData()
    form.append('file', file)
    form.append('confirm', 'true')
    try {
      const result = await api('/api/backups/restore', { method: 'POST', body: form })
      await onRestored(result)
    } catch (error) {
      message('.restore-message', error.message)
    } finally {
      working = false
      if (alive()) { find('.backup-restore-button').textContent = '导入并恢复'; render(); refresh() }
    }
  }
  void refresh()
  return { node, dispose() { disposed = true; clearTimeout(timer); controller.abort() } }
}
