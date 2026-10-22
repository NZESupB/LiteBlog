import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../../app/AppProviders'
import { api, json } from '../../lib/api'
import { errorMessage } from '../../lib/types'
import { openAvatarCropper } from '../../native/ui/avatar-cropper.js'
import { createViewScope } from '../../native/views/scope.js'

export function Login() {
  const { site, refresh, changed } = useApp(),
    navigate = useNavigate()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  if (site.user) return <Navigate to="/" replace />
  return (
    <section className="card auth-card">
      <p className="eyebrow">WELCOME HOME</p>
      <h1>欢迎回来</h1>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          const values = new FormData(event.currentTarget)
          setBusy(true)
          setError('')
          try {
            await json('/api/login', 'POST', Object.fromEntries(values))
            await refresh()
            changed()
            navigate('/', { replace: true })
          } catch (error) {
            setError(errorMessage(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          登录账号
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <p role="alert" className="form-error">
          {error}
        </p>
        <button className="btn" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </section>
  )
}
export function Account() {
  const { site, refresh, toast } = useApp(),
    navigate = useNavigate(),
    location = useLocation()
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const scope = useRef<ReturnType<typeof createViewScope> | null>(null)
  useEffect(() => {
    scope.current = createViewScope()
    return () => scope.current?.dispose()
  }, [])
  if (!site.user) return <Navigate to="/login" replace />
  const user = site.user
  const settings = location.pathname === '/settings/profile'
  const back = () => {
    if (settings && (location.state?.profileReturn || history.state?.profileReturn)) navigate(-1)
    else navigate(settings ? '/settings' : '/', { replace: true })
  }
  const submit = async (event: FormEvent<HTMLFormElement>, path: string) => {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    setBusy(true)
    setMessage('')
    try {
      await json(path, 'POST', Object.fromEntries(new FormData(form)))
      if (path === '/api/profile') await refresh()
      else form.reset()
      setMessage('已保存')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="account-page" data-motion-owned="true">
      <button className="btn-ghost back-link" onClick={back}>
        ← {settings ? '返回设置' : '返回时间轴'}
      </button>
      <h1>账号设置</h1>
      <section className="card settings-card">
        <h2>头像</h2>
        <div className="account-avatar-row">
          <span className="avatar">
            {user.avatarUrl ? <img src={user.avatarUrl} alt={user.name} /> : user.name.slice(0, 1)}
          </span>
          <label className="btn-ghost">
            更换头像
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (!file) return
                openAvatarCropper(
                  file,
                  async (blob: Blob) => {
                    const form = new FormData()
                    form.append('avatar', blob, 'avatar.jpg')
                    try {
                      await api('/api/profile/avatar', { method: 'POST', body: form })
                      await refresh()
                      toast('头像已更新')
                    } catch (error) {
                      toast(errorMessage(error))
                    }
                  },
                  () => {},
                  scope.current,
                )
              }}
            />
          </label>
          {user.avatarUrl && (
            <button
              className="btn-ghost"
              onClick={async () => {
                try {
                  await api('/api/profile/avatar', { method: 'DELETE' })
                  await refresh()
                } catch (error) {
                  toast(errorMessage(error))
                }
              }}
            >
              移除头像
            </button>
          )}
        </div>
      </section>
      <form className="card settings-card" onSubmit={(event) => submit(event, '/api/profile')}>
        <h2>个人资料</h2>
        <label>
          登录账号
          <input name="username" defaultValue={user.username} maxLength={24} required />
        </label>
        <label>
          显示名称
          <input name="displayName" defaultValue={user.displayName || user.name} maxLength={24} required />
        </label>
        <button className="btn" disabled={busy}>
          保存资料
        </button>
      </form>
      <form className="card settings-card" onSubmit={(event) => submit(event, '/api/password')}>
        <h2>修改密码</h2>
        <label>
          原密码
          <input name="oldPassword" type="password" autoComplete="current-password" required />
        </label>
        <label>
          新密码
          <input name="newPassword" type="password" autoComplete="new-password" minLength={6} required />
        </label>
        <button className="btn" disabled={busy}>
          修改密码
        </button>
      </form>
      <p role="status" className="form-error">
        {message}
      </p>
      <Link to="/settings">站点设置</Link>
    </div>
  )
}
