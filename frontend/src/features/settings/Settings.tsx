import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { Bell, ChevronRight, Database, Globe, HardDrive, Sparkles } from 'lucide-react'
import { useApp } from '../../app/AppProviders'
import { json } from '../../lib/api'
import { errorMessage } from '../../lib/types'
import { useResource } from '../../lib/use-resource'
import { ApiConfigCard } from './ApiConfigCard'
import { Backup } from './Backup'
import { animateElement, disposeAnimations, motionTiming } from '../../native/ui/motion.js'

declare global {
  interface Window {
    JournalTheme: { preference: string; current: string; set: (value: string) => boolean }
  }
}
export function NotificationToggle({
  inMenu = false,
  compact = false,
}: { inMenu?: boolean; compact?: boolean } = {}) {
  const { notifications } = useApp()
  const state = useSyncExternalStore(notifications.subscribe, notifications.getState)
  const [error, setError] = useState('')
  if (inMenu) {
    return (
      <div className="browser-notify-slot">
        <button
          type="button"
          className="dropdown-item notification-toggle"
          disabled={state.busy}
          onClick={() => {
            setError('')
            void notifications.toggle().catch((error: Error) => setError(error.message))
          }}
        >
          <Bell className="icon" />
          <span>{state.label}</span>
        </button>
        {(error || state.error || state.help) && (
          <p className="notification-help browser-notify-help" role="status">
            {error || state.error || state.help}
          </p>
        )}
      </div>
    )
  }
  if (compact) {
    return (
      <div className="compact-notify-action">
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={state.busy}
          onClick={() => {
            setError('')
            void notifications.toggle().catch((error: Error) => setError(error.message))
          }}
        >
          {state.label}
        </button>
        {(error || state.error || state.help) && (
          <span className="compact-notify-hint" role="status">
            {error || state.error || state.help}
          </span>
        )}
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        className="btn-ghost"
        disabled={state.busy}
        onClick={() => {
          setError('')
          void notifications.toggle().catch((error: Error) => setError(error.message))
        }}
      >
        {state.label}
      </button>
      <p className="storage-hint" role="status">
        {error || state.error || state.help}
      </p>
    </>
  )
}
export function Settings() {
  const { site } = useApp(),
    { section } = useParams(),
    location = useLocation()
  if (!site.user) return <Navigate to="/login" replace />
  return (
    <div className="settings-page" key={location.pathname} data-motion-owned="true">
      <Link to={section ? '/settings' : '/'} className="back-link">
        ← {section ? '返回设置' : '返回时间轴'}
      </Link>
      <h1>
        {(
          { site: '站点设置', ai: 'AI 设置', storage: '媒体存储', backup: '备份与恢复' } as Record<
            string,
            string
          >
        )[section || ''] || '设置'}
      </h1>
      {!section && (
        <div className="settings-groups">
          {/* 分组一：个人中心与首选项 */}
          <section className="settings-group-card">
            <div className="settings-profile-compact">
              <div className="profile-info-left">
                {site.user.avatarUrl ? (
                  <img src={site.user.avatarUrl} alt={site.user.name} className="avatar compact-avatar" />
                ) : (
                  <span className="avatar compact-avatar fallback">
                    {(site.user.name || '?').slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="profile-text">
                  <strong className="profile-name">{site.user.name}</strong>
                  <span className="profile-username">@{site.user.username}</span>
                </div>
              </div>
              <Link className="btn-ghost btn-sm" to="/settings/profile" state={{ profileReturn: true }}>
                编辑资料
              </Link>
            </div>

            <div className="settings-divider" />

            <div className="settings-row">
              <span className="settings-row-label">外观</span>
              <Theme compact />
            </div>

            <div className="settings-divider" />

            <div className="settings-row">
              <div className="settings-row-label-group">
                <span className="settings-row-label">浏览器通知</span>
                <small className="settings-row-desc">评论与回复时提醒</small>
              </div>
              <NotificationToggle compact />
            </div>
          </section>

          {/* 分组二：系统管理功能导航 */}
          <section className="settings-group-card">
            <div className="settings-group-title">系统管理</div>
            <nav className="settings-links-compact">
              {[
                { path: 'site', label: '站点设置', desc: '站名、起始日与私密模式', icon: Globe },
                { path: 'ai', label: 'AI 设置', desc: '语言模型与图像生成配置', icon: Sparkles },
                { path: 'storage', label: '媒体存储', desc: '本地磁盘与 WebDAV 同步', icon: HardDrive },
                { path: 'backup', label: '备份与恢复', desc: '定时快照与数据库导入', icon: Database },
              ].map(({ path, label, desc, icon: Icon }) => (
                <Link className="settings-entry-compact" key={path} to={`/settings/${path}`}>
                  <div className={`entry-icon-box icon-${path}`}>
                    <Icon size={18} />
                  </div>
                  <div className="entry-copy">
                    <strong>{label}</strong>
                    <small>{desc}</small>
                  </div>
                  <ChevronRight size={16} className="entry-arrow" />
                </Link>
              ))}
            </nav>
          </section>
        </div>
      )}
      {section === 'site' && (
        <>
          <SiteForm />
          <VideoSettings />
        </>
      )}
      {section === 'ai' && (
        <>
          <ApiConfigCard path="/api/llm" title="AI 优化" thinking />
          <ApiConfigCard path="/api/image-jobs/config" title="AI 配图" />
        </>
      )}
      {section === 'storage' && <Storage />}
      {section === 'backup' && <Backup />}
    </div>
  )
}
function Theme({ compact = false }: { compact?: boolean } = {}) {
  const [value, setValue] = useState(window.JournalTheme.preference)
  const indicator = useRef<HTMLSpanElement>(null)
  const pointer = useRef(false)
  useLayoutEffect(() => {
    const node = indicator.current!
    animateElement(
      node,
      { transform: `translateX(${['system', 'light', 'dark'].indexOf(value) * 100}%)` },
      { duration: motionTiming.selection, immediate: !pointer.current },
    )
    pointer.current = false
    return () => disposeAnimations(node)
  }, [value])
  useEffect(() => {
    const sync = () => setValue(window.JournalTheme.preference)
    window.addEventListener('journal-theme-change', sync)
    return () => window.removeEventListener('journal-theme-change', sync)
  }, [])
  const optionsContent = (
    <div
      className="theme-options"
      role="radiogroup"
      aria-label="外观"
      onPointerDown={() => {
        pointer.current = true
      }}
      onKeyDown={() => {
        pointer.current = false
      }}
    >
      <span ref={indicator} className="theme-indicator" aria-hidden="true" />
      {[
        ['system', '跟随系统'],
        ['light', '浅色'],
        ['dark', '深色'],
      ].map(([id, label]) => (
        <label key={id} className="theme-option">
          <input
            type="radio"
            name="theme"
            value={id}
            checked={value === id}
            onChange={() => {
              window.JournalTheme.set(id)
              setValue(id)
            }}
          />
          {label}
        </label>
      ))}
    </div>
  )
  if (compact) return optionsContent
  return (
    <section className="card settings-card">
      <h2>外观</h2>
      {optionsContent}
    </section>
  )
}
function SiteForm() {
  const { site, refresh } = useApp(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <form
      className="card settings-card"
      onSubmit={async (event) => {
        event.preventDefault()
        const values = new FormData(event.currentTarget)
        setBusy(true)
        try {
          await json('/api/settings', 'PUT', {
            title: values.get('title'),
            anniversary: values.get('anniversary'),
            privateMode: values.has('privateMode'),
          })
          await refresh()
          setMessage('已保存')
        } catch (error) {
          setMessage(errorMessage(error))
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2>站点信息</h2>
      <label>
        站点名称
        <input name="title" defaultValue={site.title} required />
      </label>
      <label>
        起始日期
        <input name="anniversary" type="date" defaultValue={site.anniversary} />
      </label>
      <label className="row">
        <input type="checkbox" name="privateMode" defaultChecked={site.privateMode} />
        私密模式
      </label>
      <p className="storage-hint">每篇动态可以独立选择公开正文或图片。</p>
      <button className="btn" disabled={busy}>
        保存
      </button>
      <p role="status">{message}</p>
    </form>
  )
}
function VideoSettings() {
  const { data, error } = useResource<{ enabled: boolean; available: boolean; error?: string }>(
    '/api/uploads/video/config',
  )
  const [message, setMessage] = useState('')
  return (
    <section className="card settings-card">
      <h2>视频处理</h2>
      {data && (
        <label className="row">
          <input
            type="checkbox"
            defaultChecked={data.enabled}
            onChange={async (event) => {
              const input = event.currentTarget,
                value = input.checked
              input.disabled = true
              try {
                await json('/api/uploads/video/config', 'PUT', { enabled: value })
                setMessage('设置仅影响后续上传')
              } catch (error) {
                input.checked = !value
                setMessage(errorMessage(error))
              } finally {
                input.disabled = false
              }
            }}
          />
          后台自动压缩
        </label>
      )}
      <p className="storage-hint">原件先保存，再生成 HEVC 候选；发布前可以切换版本。</p>
      <p role="status">{error || data?.error || message}</p>
    </section>
  )
}
interface StorageData {
  backend: string
  webdav: { url: string; username: string; folder: string; hasPassword: boolean }
}
function Storage() {
  const { data, error, loading } = useResource<StorageData>('/api/storage')
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  return loading ? (
    <p>正在读取…</p>
  ) : error ? (
    <p role="alert">{error}</p>
  ) : (
    data && (
      <form
        className="card settings-card"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          const values = Object.fromEntries(new FormData(event.currentTarget))
          try {
            await json('/api/storage', 'PUT', values)
            setMessage('已保存')
          } catch (error) {
            setMessage(errorMessage(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2>图片与视频存储</h2>
        <label>
          存储后端
          <select name="backend" defaultValue={data.backend}>
            <option value="local">本地</option>
            <option value="webdav">WebDAV</option>
          </select>
        </label>
        <label>
          WebDAV 地址
          <input name="url" defaultValue={data.webdav.url} placeholder="https://…/" />
        </label>
        <label>
          用户名
          <input name="username" defaultValue={data.webdav.username} />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={data.webdav.hasPassword ? '已保存，留空表示不修改' : '填写密码'}
          />
        </label>
        <label>
          根目录
          <input name="folder" defaultValue={data.webdav.folder} />
        </label>
        <p className="storage-hint">切换后历史文件仍按原记录读取；新媒体按年/月归档。</p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={async (event) => {
              const form = event.currentTarget.form!
              setBusy(true)
              try {
                const result = await json<{ message?: string }>(
                  '/api/storage/webdav/test',
                  'POST',
                  Object.fromEntries(new FormData(form)),
                )
                setMessage(result.message || '连接成功')
              } catch (error) {
                setMessage(errorMessage(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            保存并测试连接
          </button>
          <button className="btn" disabled={busy}>
            保存
          </button>
        </div>
        <p role="status">{message}</p>
      </form>
    )
  )
}
