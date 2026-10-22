import { useEffect, useState } from 'react'
import { api, json } from '../../lib/api'
import { errorMessage } from '../../lib/types'
import { createDraftStorage } from '../../native/features/composer/draft-storage.js'
interface BackupStatus {
  enabled: boolean
  time: string
  webdavReady: boolean
  state: string
  nextRunAt: string | null
  maxImportBytes: number
  lastResult: { ok: boolean; error?: string; filename?: string } | null
}
export function Backup() {
  const [status, setStatus] = useState<BackupStatus | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await api<BackupStatus>('/api/backups', { signal: controller.signal })
        if (!controller.signal.aborted) setStatus(result)
      } catch (error) {
        if (!controller.signal.aborted) setMessage(errorMessage(error))
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])
  return (
    <section className="card settings-card">
      <h2>数据库备份与恢复</h2>
      <p className="storage-hint">
        在线备份上传到媒体使用的 WebDAV 目录，只保留最新一份。数据库不包含媒体文件。
      </p>
      {status && (
        <>
          <p>{status.webdavReady ? 'WebDAV 已配置' : '请先配置 WebDAV'}</p>
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              setBusy(true)
              const values = new FormData(event.currentTarget)
              try {
                setStatus(
                  await json<BackupStatus>('/api/backups/config', 'PUT', {
                    enabled: values.has('enabled'),
                    time: values.get('time'),
                  }),
                )
                setMessage('自动备份设置已保存')
              } catch (error) {
                setMessage(errorMessage(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            <label className="row">
              <input type="checkbox" name="enabled" defaultChecked={status.enabled} />
              每天自动备份
            </label>
            <label>
              北京时间
              <input type="time" name="time" defaultValue={status.time} required />
            </label>
            <button className="btn" disabled={busy}>
              保存备份计划
            </button>
          </form>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || !status.webdavReady || status.state !== 'idle'}
            onClick={async () => {
              setBusy(true)
              try {
                setStatus(await json<BackupStatus>('/api/backups', 'POST'))
                setMessage('备份任务已启动')
              } catch (error) {
                setMessage(errorMessage(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            立即备份
          </button>
          <p role="status">
            状态：{status.state}
            {status.lastResult
              ? status.lastResult.ok
                ? ` · 最近备份成功 ${status.lastResult.filename || ''}`
                : ` · ${status.lastResult.error}`
              : ''}
          </p>
          <p className="storage-hint">
            下次自动备份：
            {status.nextRunAt
              ? new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
                '（北京时间）'
              : status.enabled
                ? '等待 WebDAV 就绪'
                : '已关闭'}
          </p>
        </>
      )}
      <h3>从 .db 文件恢复</h3>
      <p className="storage-hint">整体替换账号、动态、评论和设置。恢复后重新登录，媒体文件保留原位。</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          const form = event.currentTarget,
            values = new FormData(form),
            file = values.get('file') as File
          if (!file?.size || busy || !status || status.state !== 'idle') return
          if (status && file.size > status.maxImportBytes) {
            setMessage('文件超过导入大小上限')
            return
          }
          if (!confirm('确定整体恢复数据库？当前账号、密码、动态和设置都将被替换。')) return
          setBusy(true)
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
            setMessage(errorMessage(error))
            setBusy(false)
          }
        }}
      >
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
        <button className="btn" disabled={busy || !status || status.state !== 'idle'}>
          确认并恢复数据库
        </button>
      </form>
      <p className="form-error" role="status">
        {message}
      </p>
    </section>
  )
}
