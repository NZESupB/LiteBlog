import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessageCircle, Pencil, Trash2 } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useApp, usePostMenu } from '../../app/AppProviders'
import { api, json } from '../../lib/api'
import { parseTime, errorMessage, type Post, type Reaction } from '../../lib/types'
import { MediaGrid } from '../../components/media/MediaGrid'
import { Avatar } from '../../components/Avatar'
import { Comments } from '../comments/Comments'
import { revealElement, disposeAnimations } from '../../native/ui/motion.js'
import { Presence } from '../../components/layout/Presence'
const FALLBACK_REACTIONS = [
  '👍',
  '❤️',
  '😂',
  '😍',
  '🎉',
  '😢',
  '😡',
  '👏',
  '🔥',
  '💯',
  '🙌',
  '🥰',
  '😮',
  '🤔',
]

export function PostCard({ post }: { post: Post }) {
  const { site, compose, changed, toast } = useApp()
  const { postMenuId, setPostMenuId } = usePostMenu()
  const location = useLocation()
  const menu = postMenuId === post.id
  const [comments, setComments] = useState(0)
  const [reactions, setReactions] = useState(post.reactions)
  const [prevReactions, setPrevReactions] = useState(post.reactions)
  if (post.reactions !== prevReactions) {
    setPrevReactions(post.reactions)
    setReactions(post.reactions)
  }
  const ref = useRef<HTMLElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const choices = useRef<HTMLDivElement>(null)
  const textVisible = !site.privateMode || Boolean(site.user) || Boolean(post.public_text)
  const imagesVisible = !site.privateMode || Boolean(site.user) || Boolean(post.public_images)
  const html = useMemo(
    () =>
      DOMPurify.sanitize(
        marked.parse(post.content, { async: false }),
        imagesVisible
          ? {}
          : {
              FORBID_TAGS: ['img', 'picture', 'video', 'source'],
              FORBID_ATTR: ['background', 'style'],
            },
      ),
    [post.content, imagesVisible],
  )
  useEffect(() => {
    if (location.search.includes('comment=')) setComments((value) => value + 1)
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
    const close = () => {
      setPostMenuId((current) => (current === post.id ? null : current))
    }
    document.addEventListener('click', close)
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        more.current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', key)
    }
  }, [menu, post.id, setPostMenuId])
  useEffect(
    () => () => {
      setPostMenuId((current) => (current === post.id ? null : current))
    },
    [post.id, setPostMenuId],
  )
  return (
    <article className="card post" ref={ref}>
      <div className="post-head">
        <Avatar name={post.author} url={post.avatarUrl} />
        <div className="post-meta">
          <div className="post-author">{post.author}</div>
          <Link className="post-time" to={`/post/${post.id}`}>
            {parseTime(post.created_at).toLocaleString('zh-CN')}
            {post.updated_at !== post.created_at ? ' · 已编辑' : ''}
          </Link>
        </div>
        <div className="post-actions">
          <button
            ref={more}
            type="button"
            className="more-btn"
            aria-label="更多操作"
            aria-controls={`post-actions-${post.id}`}
            aria-expanded={menu}
            onClick={(event) => {
              event.stopPropagation()
              setPostMenuId(menu ? null : post.id)
            }}
          >
            更多
          </button>
          <Presence
            open={menu}
            className="post-menu"
            id={`post-actions-${post.id}`}
            onClick={(event) => event.stopPropagation()}
          >
            {textVisible && (
              <button
                type="button"
                className="post-menu-comment"
                onClick={() => {
                  setComments((value) => value + 1)
                  setPostMenuId(null)
                }}
              >
                <MessageCircle className="icon" />
                <span>评论</span>
              </button>
            )}
            {post.canEdit && (
              <>
                <button
                  type="button"
                  className="post-menu-comment"
                  onClick={() => {
                    compose(post, more.current)
                    setPostMenuId(null)
                  }}
                >
                  <Pencil className="icon" />
                  <span>编辑</span>
                </button>
                <button
                  type="button"
                  className="post-menu-comment"
                  onClick={async () => {
                    if (!confirm('确定删除这段日常吗？')) return
                    setPostMenuId(null)
                    more.current?.focus({ preventScroll: true })
                    try {
                      await api(`/api/posts/${post.id}`, { method: 'DELETE' })
                      changed()
                    } catch (error) {
                      toast(errorMessage(error))
                    }
                  }}
                >
                  <Trash2 className="icon" />
                  <span>删除</span>
                </button>
              </>
            )}
            {site.user && (
              <div className="reaction-picker" ref={choices}>
                {(site.reactionEmojis?.length ? site.reactionEmojis : FALLBACK_REACTIONS).map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    className="reaction-option"
                    aria-label={`点评 ${emoji}`}
                    onClick={() => {
                      void react(emoji)
                      setPostMenuId(null)
                      more.current?.focus({ preventScroll: true })
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
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
      {textVisible && (
        <Comments
          post={post}
          composing={comments > 0}
          focusRequest={comments}
          onClose={() => setComments(0)}
        />
      )}
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
