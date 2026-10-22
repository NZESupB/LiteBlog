import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageCircle, Smile } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useApp } from '../../app/AppProviders'
import { api, json } from '../../lib/api'
import { parseTime, errorMessage, type Post, type Reaction } from '../../lib/types'
import { MediaGrid } from '../../components/media/MediaGrid'
import { Comments } from '../comments/Comments'
import { revealElement, disposeAnimations } from '../../native/ui/motion.js'
import { Presence } from '../../components/layout/Presence'

export function PostCard({ post }: { post: Post }) {
  const { site, compose, changed, toast } = useApp()
  const location = useLocation()
  const [menu, setMenu] = useState(false),
    [comments, setComments] = useState(false)
  const [picker, setPicker] = useState(false),
    [reactions, setReactions] = useState(post.reactions)
  const ref = useRef<HTMLElement>(null)
  const textVisible = !site.privateMode || Boolean(site.user) || Boolean(post.public_text)
  const imagesVisible = !site.privateMode || Boolean(site.user) || Boolean(post.public_images)
  const html = DOMPurify.sanitize(
    marked.parse(post.content, { async: false }),
    imagesVisible ? {} : { FORBID_TAGS: ['img', 'picture', 'video', 'source'] },
  )
  useEffect(() => {
    if (location.search.includes('comment=')) setComments(true)
  }, [location.search])
  useEffect(() => {
    const node = ref.current
    if (node) revealElement(node)
    return () => {
      if (node) disposeAnimations(node)
    }
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    document.addEventListener('click', close)
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', key)
    }
  }, [menu])
  return (
    <article className="card post" ref={ref}>
      <div className="post-head">
        <span className="avatar">
          {post.avatarUrl ? <img src={post.avatarUrl} alt="" /> : post.author.slice(0, 1)}
        </span>
        <div className="post-meta">
          <div className="post-author">{post.author}</div>
          <Link className="post-time" to={`/post/${post.id}`}>
            {parseTime(post.created_at).toLocaleString('zh-CN')}
            {post.updated_at !== post.created_at ? ' · 已编辑' : ''}
          </Link>
        </div>
        <div className="post-actions">
          <button
            className="more-btn"
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={(event) => {
              event.stopPropagation()
              setMenu(!menu)
            }}
          >
            更多
          </button>
          <Presence
            open={menu}
            className="post-menu"
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            {textVisible && (
              <button
                role="menuitem"
                onClick={() => {
                  setComments(true)
                  setMenu(false)
                }}
              >
                <MessageCircle className="icon" />
                评论
              </button>
            )}
            {site.user && (
              <button
                role="menuitem"
                onClick={() => {
                  setPicker(!picker)
                  setMenu(false)
                }}
              >
                <Smile className="icon" />
                表情点评
              </button>
            )}
            {post.canEdit && (
              <>
                <button
                  role="menuitem"
                  onClick={(event) => {
                    compose(post, event.currentTarget)
                    setMenu(false)
                  }}
                >
                  编辑
                </button>
                <button
                  role="menuitem"
                  onClick={async () => {
                    if (!confirm('确定删除这段日常吗？')) return
                    try {
                      await api(`/api/posts/${post.id}`, { method: 'DELETE' })
                      changed()
                    } catch (error) {
                      toast(errorMessage(error))
                    }
                  }}
                >
                  删除
                </button>
              </>
            )}
          </Presence>
        </div>
      </div>
      {textVisible && post.content && (
        <div
          className="post-content"
          dangerouslySetInnerHTML={{
            __html: html,
          }}
        />
      )}
      {!textVisible && <p className="private-tip">该内容仅登录后可见</p>}
      <MediaGrid items={post.images} />
      {!!reactions.length && (
        <div className="reactions">
          {reactions.map((reaction) => (
            <button
              className={`reaction${reaction.reacted ? ' active' : ''}`}
              key={reaction.emoji}
              aria-pressed={reaction.reacted}
              disabled={!site.user}
              onClick={() => react(reaction.emoji)}
            >
              {reaction.emoji} {reaction.count}
            </button>
          ))}
        </div>
      )}
      {picker && (
        <div className="reaction-picker">
          {site.reactionEmojis.map((emoji) => (
            <button
              key={emoji}
              aria-label={`点评 ${emoji}`}
              onClick={() => {
                void react(emoji)
                setPicker(false)
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {textVisible && <Comments post={post} composing={comments} />}
    </article>
  )
  async function react(emoji: string) {
    try {
      const result = await json<{ reactions: Reaction[] }>(`/api/posts/${post.id}/reactions`, 'POST', {
        emoji,
      })
      setReactions(result.reactions)
    } catch (error) {
      toast(errorMessage(error))
    }
  }
}
