import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Smile, X } from 'lucide-react'
import { useApp } from '../../app/AppProviders'
import { api, json } from '../../lib/api'
import { errorMessage, parseTime, type Comment, type Post } from '../../lib/types'
import { attachInlineInputViewport } from '../../native/composer-viewport.js'
import { attachEmojiButton, closeEmojiPanel } from '../../native/ui/emoji-picker.js'

export function Comments({ post, composing }: { post: Post; composing: boolean }) {
  const { site } = useApp()
  const [comments, setComments] = useState<Comment[]>([])
  const [reply, setReply] = useState<Comment | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const showForm = composing || replyOpen
  const form = useRef<HTMLFormElement>(null),
    input = useRef<HTMLInputElement>(null),
    emoji = useRef<HTMLButtonElement>(null)
  const [revision, setRevision] = useState(0)
  const location = useLocation()
  useEffect(() => {
    const controller = new AbortController()
    api<{ comments: Comment[] }>(`/api/posts/${post.id}/comments`, { signal: controller.signal })
      .then(({ comments }) => {
        if (!controller.signal.aborted) {
          setComments(comments)
          setError('')
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error))
      })
    return () => controller.abort()
  }, [post.id, revision])
  useEffect(() => {
    if (!showForm || !site.user || !form.current || !input.current || !emoji.current) return
    const cleanup = attachInlineInputViewport(form.current, input.current)
    const detach = attachEmojiButton(emoji.current, input.current)
    return () => {
      cleanup()
      if (typeof detach === 'function') detach()
      closeEmojiPanel(true)
    }
  }, [site.user, showForm])
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('comment')
    if (!id) return
    const element = document.getElementById(`comment-${id}`)
    if (element) {
      element.scrollIntoView({ block: 'center' })
      element.focus({ preventScroll: true })
    }
  }, [comments, location.search])
  return (
    <section className="comments" aria-label="评论">
      <div className="comment-list">
        {comments.map((comment) => (
          <div className="comment" key={comment.id} id={`comment-${comment.id}`} tabIndex={-1}>
            <div className="comment-body">
              <strong>{comment.author}</strong>
              {comment.reply_author && <span> 回复 {comment.reply_author}</span>}
              {comment.reply_content && (
                <button
                  className="comment-reply-quote"
                  onClick={() =>
                    document
                      .getElementById(`comment-${comment.reply_to}`)
                      ?.scrollIntoView({ block: 'center' })
                  }
                >
                  {comment.reply_content}
                </button>
              )}
              <p>{comment.content}</p>
              <time>{parseTime(comment.created_at).toLocaleString('zh-CN')}</time>
              {site.user && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setReplyOpen(true)
                    setReply(comment)
                    input.current?.focus()
                  }}
                >
                  回复
                </button>
              )}
              {site.user &&
                (comment.user_id === site.user.id || post.user_id === site.user.id) &&
                Date.now() - parseTime(comment.created_at).getTime() <= 86400000 && (
                  <button
                    className="btn-ghost"
                    onClick={async () => {
                      if (!confirm('确定删除这条评论吗？')) return
                      try {
                        await api(`/api/posts/${post.id}/comments/${comment.id}`, { method: 'DELETE' })
                        setRevision((n) => n + 1)
                      } catch (error) {
                        setError(errorMessage(error))
                      }
                    }}
                  >
                    删除
                  </button>
                )}
            </div>
          </div>
        ))}
      </div>
      {site.user && showForm && (
        <form
          className="comment-form"
          ref={form}
          onSubmit={async (event) => {
            event.preventDefault()
            if (busy || !input.current?.value.trim()) return
            setBusy(true)
            setError('')
            try {
              await json(`/api/posts/${post.id}/comments`, 'POST', {
                content: input.current.value,
                replyToId: reply?.id,
              })
              input.current.value = ''
              setReply(null)
              setRevision((n) => n + 1)
            } catch (error) {
              setError(errorMessage(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          {reply && (
            <div className="comment-reply-state">
              <span>回复 {reply.author}</span>
              <button
                type="button"
                aria-label="取消回复"
                className="comment-reply-cancel"
                onClick={() => setReply(null)}
              >
                <X className="icon" />
              </button>
            </div>
          )}
          <input
            ref={input}
            aria-label="评论内容"
            placeholder={reply ? '写下回复…' : '写下评论…'}
            maxLength={500}
            required
          />
          <button ref={emoji} type="button" className="btn-ghost" aria-label="选择表情">
            <Smile className="icon" />
          </button>
          <button className="btn" disabled={busy}>
            发送
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
