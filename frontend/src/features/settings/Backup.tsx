import { useEffect, useState, type FormEvent } from 'react'
import { api, json } from '../../lib/api'
import { errorMessage } from '../../lib/types'
import { createDraftStorage } from '../../native/features/composer/draft-storage.js'
import { TimePicker } from '../../components/ui/TimePicker'

interface BackupStatus {
  enabled: boolean
  time: string
  webdavReady: boolean
  folder?: string
  state: string
  nextRunAt: string | null
  maxImportBytes: number
  lastResult: {
    ok: boolean
    error?: string
    filename?: string
    finishedAt?: string
    size?: number
  } | null
}

export function Backup() {
  const [status, setStatus] = useState<BackupStatus | null>(null),
    [configMessage, setConfigMessage] = useState(''),
    [configOk, setConfigOk] = useState(false),
    [restoreMessage, setRestoreMessage] = useState(''),
    [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api<BackupStatus>('/api/backups', { signal: controller.signal })
        if (!controller.signal.aborted) setStatus(result)
      } catch (error) {
        if (!controller.signal.aborted) {
          setConfigOk(false)
          setConfigMessage(errorMessage(error))
        }
      }
      if (!controller.signal.aborted) {
        timer = setTimeout(poll, 5000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  const handleSaveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setConfigMessage('')
    const values = new FormData(event.currentTarget)
    try {
      const next = await json<BackupStatus>('/api/backups/config', 'PUT', {
        enabled: values.has('enabled'),
        time: values.get('time'),
      })
      setStatus(next)
      setConfigOk(true)
      setConfigMessage('定时设置已保存')
    } catch (error) {
      setConfigOk(false)
      setConfigMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleBackupNow = async () => {
    if (busy || !status || status.state !== 'idle') return
    setBusy(true)
    setConfigMessage('')
    try {
      const next = await json<BackupStatus>('/api/backups', 'POST')
      setStatus(next)
      setConfigOk(true)
      setConfigMessage('备份已开始，可以离开此页面；结果会保存在服务中。')
    } catch (error) {
      setConfigOk(false)
      setConfigMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget,
      values = new FormData(form),
      file = values.get('file') as File
    if (!file?.size || busy || !status || status.state !== 'idle') return
    if (status && file.size > status.maxImportBytes) {
      setRestoreMessage('文件超过导入大小上限')
      return
    }
    if (!confirm('确定整体恢复数据库？当前账号、密码、动态和设置都将被替换。')) return
    setBusy(true)
    setRestoreMessage('')
    values.set('confirm', 'true')
    try {
      await api('/api/backups/restore', { method: 'POST', body: values })
      try {
        for (const key of Object.keys(localStorage))
          if (
            key.startsWith(`compose-draft:${location.origin}:`) ||
            key.startsWith(`compose-draft-id:${location.origin}:`)
          )
            localStorage.removeItem(key)
        for (const key of Object.keys(sessionStorage))
          if (key.startsWith('compose-draft:')) sessionStorage.removeItem(key)
        const storage = createDraftStorage(() => null)
        const db = await storage.draftFileDb()
        if (db)
          await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction('files', 'readwrite')
            transaction.objectStore('files').clear()
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
          })
      } catch (error) {
        alert(`数据库已恢复，但浏览器草稿清理失败：${errorMessage(error)}。请在重新写作前丢弃旧草稿。`)
      }
      location.hash = '#/login'
      location.reload()
    } catch (error) {
      setRestoreMessage(errorMessage(error))
      setBusy(false)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`
    return `${bytes}B`
  }

  return (
    <div className="backup-settings">
      <section className="card settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>数据库备份</h2>
            <p>备份到图片存储所配置的 WebDAV 目录，仅保留最新一份数据库。</p>
          </div>
        </div>
        <p className="backup-connection storage-status" role="status">
          {status ? (
            status.webdavReady ? (
              <>
                共用 WebDAV 目录：<strong>{status.folder || '/'}</strong>
              </>
            ) : (
              '尚未配置完整的 WebDAV。请先到图片存储设置连接；导入恢复仍可使用。'
            )
          ) : (
            '正在读取备份状态…'
          )}
        </p>
        {status && (
          <form className="backup-config" onSubmit={handleSaveConfig}>
            <fieldset className="backup-fields" disabled={busy || status.state !== 'idle'}>
              <label className="backup-toggle-row">
                <span className="settings-row-label-group">
                  <span className="settings-row-label">每天自动备份</span>
                  <small className="settings-row-desc">关闭后仍可随时手动备份</small>
                </span>
                <input type="checkbox" name="enabled" defaultChecked={status.enabled} />
              </label>
              <div className="backup-row-divider" aria-hidden="true" />
              <div className="settings-row backup-time-row">
                <div className="settings-row-label-group">
                  <label className="backup-time-label" htmlFor="backup-time">
                    备份时间
                  </label>
                  <small className="settings-row-desc">北京时间</small>
                </div>
                <TimePicker
                  id="backup-time"
                  name="time"
                  defaultValue={status.time}
                  required
                  ariaLabel="北京时间"
                />
              </div>
              <p className="storage-hint">
                服务运行时自动执行；重新启动后会补执行当天错过的备份。当天手动备份成功后，不再重复自动备份。
              </p>
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn-ghost backup-now"
                  disabled={busy || !status.webdavReady || status.state !== 'idle'}
                  onClick={handleBackupNow}
                >
                  立即备份
                </button>
                <span className="spacer" />
                <button className="btn" type="submit" disabled={busy || status.state !== 'idle'}>
                  保存备份计划
                </button>
              </div>
            </fieldset>
          </form>
        )}
        {status && (
          <dl className="backup-status" aria-live="polite">
            <dt>当前状态</dt>
            <dd className="backup-state">
              {busy
                ? '正在提交…'
                : status.state === 'backing-up'
                  ? '正在生成快照并上传…'
                  : status.state === 'restoring'
                    ? '正在恢复…'
                    : '就绪'}
            </dd>
            <dt>下次自动备份</dt>
            <dd className="backup-next">
              {status.nextRunAt
                ? `${new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`
                : status.enabled
                  ? '等待配置 WebDAV'
                  : '已关闭'}
            </dd>
            <dt>上次备份</dt>
            <dd className="backup-last">
              {status.lastResult
                ? `${status.lastResult.ok ? '备份成功' : '备份失败'}${
                    status.lastResult.filename ? ` · ${status.lastResult.filename}` : ''
                  }${status.lastResult.error ? `：${status.lastResult.error}` : ''}`
                : '暂无备份记录'}
            </dd>
          </dl>
        )}
        {configMessage && (
          <p
            className="form-message backup-message"
            data-state={configOk ? 'success' : 'error'}
            role={configOk ? 'status' : 'alert'}
          >
            {configMessage}
          </p>
        )}
      </section>

      <section className="card settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>导入数据库恢复</h2>
            <p>选择本站备份的 .db 文件，整体替换当前数据库。</p>
          </div>
        </div>
        <p className="backup-warning">
          账号、密码、动态、评论、草稿、任务记录、通知订阅、站点设置和个人设置均以导入文件为准。恢复后，所有成员都需要重新登录。
        </p>
        <p className="storage-hint">
          图片、视频和头像不包含在 .db
          中。现有媒体文件会保留原位，缺失文件需要另行补回。正在上传、处理视频或生成配图时，请先完成或取消任务。
        </p>
        <form className="backup-restore" onSubmit={handleRestore}>
          <fieldset className="backup-restore-fields" disabled={busy || !status || status.state !== 'idle'}>
            <label>
              数据库文件
              <input
                type="file"
                name="file"
                accept=".db"
                required
                disabled={busy || !status || status.state !== 'idle'}
              />
            </label>
            <p className="storage-hint backup-limit">
              {status?.maxImportBytes
                ? `文件上限 ${formatSize(status.maxImportBytes)}。恢复前会在服务的数据目录内保留当前数据库副本。`
                : '正在读取文件大小上限…'}
            </p>
            <div className="settings-actions">
              <button
                type="submit"
                className="btn backup-restore-button"
                disabled={busy || !status || status.state !== 'idle'}
              >
                确认并恢复数据库
              </button>
            </div>
          </fieldset>
        </form>
        {restoreMessage && (
          <p className="form-message restore-message" data-state="error" role="alert">
            {restoreMessage}
          </p>
        )}
      </section>
    </div>
  )
}
