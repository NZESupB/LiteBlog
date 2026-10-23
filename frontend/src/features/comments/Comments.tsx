import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Smile, X } from 'lucide-react'
import { useApp } from '../../app/AppProviders'
import { api, json } from '../../lib/api'
import { errorMessage, parseTime, type Comment, type Post } from '../../lib/types'
import { attachInlineInputViewport } from '../../native/composer-viewport.js'
import { attachEmojiButton, closeEmojiPanel } from '../../native/ui/emoji-picker.js'

export function Comments({
  post,
  composing,
  focusRequest = 0,
  onClose,
}: {
  post: Post
  composing: boolean
  focusRequest?: number
  onClose?: () => void
}) {
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
  const edits = useRef(0)
  const submission = useRef<AbortController | null>(null)
  const [focusVersion, setFocusVersion] = useState(0)
  const userId = site.user?.id
  const closeForm = useCallback(() => {
    setReply(null)
    setReplyOpen(false)
    onClose?.()
    closeEmojiPanel(true)
  }, [onClose])
  useEffect(() => {
    const controller = new AbortController()
    submission.current = controller
    return () => controller.abort()
  }, [post.id])
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
    if (showForm && userId) input.current?.focus({ preventScroll: true })
  }, [showForm, focusVersion, focusRequest, userId])
  useEffect(() => {
    if (!showForm) return
    const onOutside = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (form.current?.contains(target)) return
      if (target instanceof Element && target.closest('.emoji-panel')) return
      if (!input.current?.value.trim()) {
        closeForm()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeForm()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('click', onOutside)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', onOutside)
      window.removeEventListener('keydown', onKey)
    }
  }, [showForm, closeForm])
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
                    ++edits.current
                    setReplyOpen(true)
                    setReply(comment)
                    setFocusVersion((value) => value + 1)
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
            const node = input.current
            const controller = submission.current
            if (busy || !node?.value.trim() || !controller || controller.signal.aborted) return
            const content = node.value
            const version = edits.current
            const replyToId = reply?.id
            setBusy(true)
            setError('')
            try {
              await json(
                `/api/posts/${post.id}/comments`,
                'POST',
                {
                  content: content.trim(),
                  replyToId,
                },
                controller.signal,
              )
              if (controller.signal.aborted) return
              if (edits.current === version && input.current === node && node.value === content) {
                node.value = ''
                closeForm()
              }
              setRevision((n) => n + 1)
            } catch (error) {
              if (!controller.signal.aborted) setError(errorMessage(error))
            } finally {
              if (!controller.signal.aborted) setBusy(false)
            }
          }}
        >
          <div className="comment-form-head">
            <span>{reply ? `回复 ${reply.author}` : '发表评论'}</span>
            <button type="button" className="comment-form-close" aria-label="收起评论框" onClick={closeForm}>
              <X className="icon" />
              <span>收起</span>
            </button>
          </div>
          <input
            ref={input}
            aria-label="评论内容"
            placeholder={reply ? '写下回复…' : '写下评论…'}
            maxLength={500}
            onInput={() => {
              ++edits.current
            }}
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
