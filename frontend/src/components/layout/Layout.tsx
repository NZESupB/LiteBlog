import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Bell, Heart, Image, List, PenLine, Settings, UserRound } from 'lucide-react'
import { useApp } from '../../app/AppProviders'
import { api } from '../../lib/api'
import { errorMessage, type Notice } from '../../lib/types'
import { NotificationToggle } from '../../features/settings/Settings'
import { Presence } from './Presence'

export function Layout({ children }: { children: React.ReactNode }) {
  const { site, compose, notifications, refresh, changed, toast } = useApp()
  const location = useLocation(),
    navigate = useNavigate()
  const header = useRef<HTMLElement>(null),
    sentinel = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<'user' | 'bell' | null>(null),
    [items, setItems] = useState<Notice[]>([])
  const [clock, setClock] = useState(Date.now())
  const [writeVisible, setWriteVisible] = useState(false)
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    const heading = document.getElementById('journalWriteAnchor')
    setWriteVisible(false)
    if (location.pathname !== '/' || !heading) return
    const observer = new IntersectionObserver(([entry]) => setWriteVisible(!entry.isIntersecting), {
      rootMargin: `-${header.current?.getBoundingClientRect().height || 58}px 0px 0px`,
    })
    observer.observe(heading)
    return () => observer.disconnect()
  }, [location.pathname])
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000)
    const close = () => setMenu(null),
      key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close()
      }
    document.addEventListener('click', close)
    document.addEventListener('keydown', key)
    return () => {
      clearInterval(timer)
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', key)
    }
  }, [])
  useEffect(() => {
    if (!header.current || !sentinel.current) return
    const resize = new ResizeObserver(() =>
      document.documentElement.style.setProperty(
        '--header-h',
        `${Math.round(header.current!.getBoundingClientRect().height)}px`,
      ),
    )
    const observer = new IntersectionObserver(([entry]) =>
      header.current?.classList.toggle('is-scrolled', !entry.isIntersecting),
    )
    resize.observe(header.current)
    observer.observe(sentinel.current)
    return () => {
      resize.disconnect()
      observer.disconnect()
    }
  }, [])
  useEffect(() => {
    if (!site.user) {
      setItems([])
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const data = await api<{ items: Notice[] }>('/api/notifications', { signal: controller.signal })
        if (!controller.signal.aborted) {
          setItems(data.items)
          setUnread(data.items.length)
        }
      } catch (error) {
        if (!controller.signal.aborted) toast(errorMessage(error))
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 60000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [site.user, toast])
  useEffect(() => {
    setMenu(null)
  }, [location.pathname])
  const day = new Date(clock),
    midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const progress = (clock - midnight) / 86400000
  const days = site.anniversary
    ? Math.floor((midnight - new Date(`${site.anniversary}T00:00:00`).getTime()) / 86400000) + 1
    : 0
  return (
    <>
      <div className="top-material-sentinel" ref={sentinel} />
      <header className="site-header" ref={header}>
        <div className="header-inner">
          <div className="site-brand">
            <Link className="site-title" to="/">
              <span className="site-heart">
                <Heart className="icon" />
              </span>
              <span className="site-name">{site.title}</span>
            </Link>
            {days > 0 && (
              <div className={`days${progress > 0.5 ? ' is-filled' : ''}`}>
                <span
                  className="day-progress"
                  role="progressbar"
                  aria-label="到下一天的进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.floor(progress * 100)}
                  style={{ '--day-progress': progress } as React.CSSProperties}
                >
                  <span className="day-progress-fill" aria-hidden="true" />
                  <span className="day-progress-label">
                    <strong>{days}天</strong>
                  </span>
                </span>
              </div>
            )}
          </div>
          <nav className="site-nav" aria-label="主要导航">
            <div className="nav-segments">
              <NavLink end to="/">
                时间轴
              </NavLink>
              <NavLink to="/gallery">相册</NavLink>
            </div>
            <span className="header-write-slot" id="headerWriteSlot" hidden={!writeVisible}>
              <button
                className="write-trigger header-write"
                id="headerWrite"
                onClick={(event) => compose(null, event.currentTarget)}
              >
                写日常
              </button>
            </span>
            <span id="userArea">
              {site.user ? (
                <>
                  <button
                    className="bell-btn"
                    aria-label={`通知${unread ? `，${unread}条未读` : ''}`}
                    aria-expanded={menu === 'bell'}
                    onClick={(event) => {
                      event.stopPropagation()
                      const opening = menu !== 'bell'
                      setMenu(opening ? 'bell' : null)
                      if (opening)
                        void api('/api/notifications/read', { method: 'POST' })
                          .then(() => setUnread(0))
                          .catch((error) => toast(errorMessage(error)))
                    }}
                  >
                    <Bell className="icon" />
                    {!!unread && <span className="bell-badge">{unread}</span>}
                  </button>
                  <button
                    className="avatar-btn"
                    aria-label="账号菜单"
                    aria-expanded={menu === 'user'}
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenu(menu === 'user' ? null : 'user')
                    }}
                  >
                    {site.user.avatarUrl ? (
                      <img src={site.user.avatarUrl} alt="" />
                    ) : (
                      <UserRound className="icon" />
                    )}
                  </button>
                  <Presence
                    open={menu === 'bell'}
                    className="dropdown bell-dropdown"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <h3>新评论</h3>
                    {items.length ? (
                      items.map((item) => (
                        <Link
                          key={item.id}
                          to={`/post/${item.post_id}?comment=${item.id}`}
                          onClick={() => setMenu(null)}
                        >
                          <strong>{item.author}</strong>
                          <span>{item.content}</span>
                        </Link>
                      ))
                    ) : (
                      <p>暂时没有新评论</p>
                    )}
                    <NotificationToggle />
                  </Presence>
                  <Presence
                    open={menu === 'user'}
                    className="dropdown"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <strong>{site.user.name}</strong>
                    <Link to="/account">账号设置</Link>
                    <Link to="/settings">设置</Link>
                    <NotificationToggle />
                    <button
                      onClick={async () => {
                        try {
                          await notifications.disable()
                          await api('/api/logout', { method: 'POST' })
                          await refresh()
                          changed()
                          navigate('/')
                        } catch (error) {
                          toast(errorMessage(error))
                        }
                      }}
                    >
                      退出登录
                    </button>
                  </Presence>
                </>
              ) : (
                <Link to="/login" className="btn-ghost">
                  登录
                </Link>
              )}
            </span>
          </nav>
        </div>
      </header>
      <main id="main" className="container">
        {children}
      </main>
      <nav className="mobile-nav" aria-label="主要导航">
        <NavLink to="/" end>
          <span className="mobile-nav-icon">
            <List className="icon" />
          </span>
          <span>时间轴</span>
        </NavLink>
        <NavLink to="/gallery">
          <span className="mobile-nav-icon">
            <Image className="icon" />
          </span>
          <span>相册</span>
        </NavLink>
        <button
          className="mobile-compose"
          aria-label="写日常"
          onClick={(event) => compose(null, event.currentTarget)}
        >
          <PenLine className="icon" />
          <span>写日常</span>
        </button>
        <NavLink to="/settings">
          <span className="mobile-nav-icon">
            <Settings className="icon" />
          </span>
          <span>设置</span>
        </NavLink>
      </nav>
    </>
  )
}
