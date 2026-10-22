import { useEffect, useRef, useState, useCallback } from 'react'
import { useApp } from '../../app/AppProviders'
import { api } from '../../lib/api'
import { dateLabel, monthKey, errorMessage, type Post } from '../../lib/types'
import { PostCard } from '../posts/PostCard'
import { Archive } from './Archive'

interface Page {
  posts: Post[]
  hasMore: boolean
  nextCursor: string | null
  total: number
}
export function Timeline() {
  const { compose, revision } = useApp()
  const [month, setMonth] = useState('')
  const [page, setPage] = useState<Page>({ posts: [], hasMore: false, nextCursor: null, total: 0 })
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true)
  const state = useRef({
    cursor: null as string | null,
    more: true,
    busy: false,
    controller: new AbortController(),
    generation: 0,
  })
  const sentinel = useRef<HTMLDivElement>(null)
  const [months, setMonths] = useState<{ month: string; count: number }[]>([])
  const [activeMonth, setActiveMonth] = useState('')
  const load = useCallback(
    async (reset = false) => {
      const current = state.current
      if (current.busy || !current.more) return
      current.busy = true
      setLoading(true)
      setError('')
      const query = new URLSearchParams({ limit: '20', tz: String(-new Date().getTimezoneOffset()) })
      if (current.cursor) query.set('cursor', current.cursor)
      else if (month) query.set('month', month)
      try {
        const next = await api<Page>(`/api/posts?${query}`, { signal: current.controller.signal })
        if (current !== state.current || current.controller.signal.aborted) return
        current.cursor = next.nextCursor
        current.more = next.hasMore
        setPage((previous) => ({ ...next, posts: reset ? next.posts : [...previous.posts, ...next.posts] }))
      } catch (error) {
        if (!current.controller.signal.aborted) setError(errorMessage(error))
      } finally {
        if (current === state.current && !current.controller.signal.aborted) {
          current.busy = false
          setLoading(false)
        }
      }
    },
    [month],
  )
  useEffect(() => {
    const controller = new AbortController()
    state.current = {
      cursor: null,
      more: true,
      busy: false,
      controller,
      generation: state.current.generation + 1,
    }
    setPage({ posts: [], hasMore: false, nextCursor: null, total: 0 })
    void load(true)
    api<{ months: { month: string; count: number }[] }>(
      `/api/posts/archive?tz=${-new Date().getTimezoneOffset()}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setMonths(data.months)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [load, revision])
  useEffect(() => {
    if (!sentinel.current || loading || error || !page.hasMore) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void load()
      },
      { rootMargin: '0px 0px 400px' },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [loading, error, page.hasMore, load])
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) setActiveMonth((entry.target as HTMLElement).dataset.month || '')
      },
      { rootMargin: '-10% 0px -60% 0px' },
    )
    document.querySelectorAll('.day-group').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [page.posts])
  const groups = new Map<string, Post[]>()
  for (const post of page.posts) {
    const label = dateLabel(post.created_at)
    groups.set(label, [...(groups.get(label) || []), post])
  }
  return (
    <>
      <div className="journal-heading" id="journalWriteAnchor">
        <div>
          <p className="eyebrow">OUR JOURNAL</p>
          <h1>一起，把日子记下来。</h1>
          <p>那些值得被记住的细小瞬间。</p>
        </div>
        <div className="journal-heading-actions">
          <button className="btn write-trigger" onClick={(event) => compose(null, event.currentTarget)}>
            写日常
          </button>
        </div>
      </div>
      <Archive
        months={months}
        active={activeMonth || month}
        onPick={(value) => {
          setMonth(value)
          window.scrollTo({ top: 0 })
        }}
      />
      {month && (
        <button className="btn-ghost" onClick={() => setMonth('')}>
          回到最新
        </button>
      )}
      <div className="post-list">
        {[...groups].map(([label, posts]) => (
          <section key={label} className="day-group" data-month={monthKey(posts[0].created_at)}>
            <h2 className="date-divider">{label}</h2>
            {posts.map((post) => (
              <PostCard post={post} key={`${post.id}-${revision}`} />
            ))}
          </section>
        ))}
      </div>
      {!loading && !page.posts.length && !error && (
        <div className="journal-empty">
          <img src="/images/journal-cover.jpg" alt="" />
          <h2>日常，等你落笔</h2>
          <p>写下一句话，或者留下一张照片。</p>
        </div>
      )}
      <div ref={sentinel} className="load-more" aria-live="polite">
        {loading ? (
          '正在读取…'
        ) : error ? (
          <>
            <p role="alert">{error}</p>
            <button className="btn-ghost" onClick={() => load(!page.posts.length)}>
              重新加载
            </button>
          </>
        ) : page.hasMore ? (
          <button className="btn-ghost" onClick={() => load()}>
            加载更多
          </button>
        ) : page.posts.length ? (
          '已经到最初的日常了'
        ) : (
          ''
        )}
      </div>
      <button className="to-top" aria-label="回到顶部" onClick={() => window.scrollTo({ top: 0 })}>
        ↑
      </button>
    </>
  )
}
