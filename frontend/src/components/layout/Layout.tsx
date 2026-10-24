import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Bell, Heart, Image, List, LogOut, Settings, User } from 'lucide-react'
import { useApp } from '../../app/AppProviders'
import { api } from '../../lib/api'
import { JOURNAL_WRITE_ANCHOR_ID } from '../../lib/dom-ids'
import { errorMessage, type Notice } from '../../lib/types'
import { NotificationToggle } from '../../features/settings/Settings'
import { Presence } from './Presence'
import { WriteIcon } from '../WriteIcon'
import { Avatar } from '../Avatar'
import { animatePresence, disposeAnimations } from '../../native/ui/motion.js'

export function Layout({ children }: { children: React.ReactNode }) {
  const { site, compose, notifications, refresh, changed, toast } = useApp()
  const location = useLocation(),
    navigate = useNavigate()
  const header = useRef<HTMLElement>(null),
    sentinel = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<'user' | 'bell' | null>(null),
    [items, setItems] = useState<Notice[]>([])
  const writeSlot = useRef<HTMLSpanElement>(null)
  const [unread, setUnread] = useState(0)
  const userId = site.user?.id
  useLayoutEffect(() => {
    const slot = writeSlot.current!
    void animatePresence(slot, false, { className: 'header-write-presence', immediate: true })
    const source = document.getElementById(JOURNAL_WRITE_ANCHOR_ID)
    if (location.pathname !== '/' || !userId || !source) return
    const headerHeight = Math.round(header.current!.getBoundingClientRect().height)
    const observer = new IntersectionObserver(
      ([entry]) => {
        void animatePresence(slot, !entry.isIntersecting, {
          className: 'header-write-presence',
          duration: 240,
        })
      },
      { rootMargin: `-${headerHeight + 8}px 0px 0px 0px` },
    )
    observer.observe(source)
    return () => {
      observer.disconnect()
      void animatePresence(slot, false, { className: 'header-write-presence', immediate: true })
      disposeAnimations(slot)
    }
  }, [location.pathname, userId])
  useEffect(() => {
    const close = () => setMenu(null),
      key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close()
      }
    document.addEventListener('click', close)
    document.addEventListener('keydown', key)
    return () => {
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
            {site.anniversary && <DayProgress anniversary={site.anniversary} />}
          </div>
          <nav className="site-nav" aria-label="主要导航">
            <div className="nav-segments">
              <NavLink end to="/">
                时间轴
              </NavLink>
              <NavLink to="/gallery">相册</NavLink>
            </div>
            <span ref={writeSlot} className="header-write-slot" id="headerWriteSlot" hidden>
              <button
                className="write-trigger header-write"
                id="headerWrite"
                type="button"
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
                    <Avatar name={site.user.name} url={site.user.avatarUrl} className="small" />
                  </button>
                  <Presence
                    open={menu === 'bell'}
                    className="dropdown bell-dropdown"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="dropdown-name">新评论</div>
                    {items.length ? (
                      items.map((item) => (
                        <Link
                          key={item.id}
                          className="bell-item"
                          to={`/post/${item.post_id}?comment=${item.id}`}
                          onClick={() => setMenu(null)}
                        >
                          <span className="bell-item-line">
                            <strong>{item.author}</strong>: {item.content}
                          </span>
                        </Link>
                      ))
                    ) : (
                      <div className="bell-empty">暂无新评论</div>
                    )}
                    <NotificationToggle inMenu />
                  </Presence>
                  <Presence
                    open={menu === 'user'}
                    className="dropdown"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="dropdown-name">{site.user.name}</div>
                    <Link to="/account" className="dropdown-item" onClick={() => setMenu(null)}>
                      <User className="icon" />
                      <span>账号设置</span>
                    </Link>
                    <Link to="/settings" className="dropdown-item" onClick={() => setMenu(null)}>
                      <Settings className="icon" />
                      <span>设置</span>
                    </Link>
                    <NotificationToggle inMenu />
                    <button
                      type="button"
                      className="dropdown-item logout"
                      onClick={async () => {
                        setMenu(null)
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
                      <LogOut className="icon" />
                      <span>退出登录</span>
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
        <a
          className="mobile-compose"
          href="#/"
          aria-label="写日常"
          onClick={(event) => {
            event.preventDefault()
            compose(null, event.currentTarget)
          }}
        >
          <span>
            <WriteIcon />
          </span>
          <span>写日常</span>
        </a>
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

// 纪念日进度胶囊自带时钟，30 秒粒度足够；避免整个顶栏每秒重渲染。
function DayProgress({ anniversary }: { anniversary: string }) {
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])
  const day = new Date(clock),
    midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const progress = (clock - midnight) / 86400000
  const days = Math.floor((midnight - new Date(`${anniversary}T00:00:00`).getTime()) / 86400000) + 1
  if (days <= 0) return null
  return (
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
  )
}
