import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import {
  Bold,
  Italic,
  Strikethrough,
  Heading,
  Quote,
  Code,
  SquareCode,
  List,
  ListOrdered,
  ListChecks,
  Link,
  Smile,
  Sparkles,
  Image,
  Camera,
  Lock,
  Play,
  Check,
} from 'lucide-react'
import { useApp } from '../../app/AppProviders'
import type { Post } from '../../lib/types'
import { createComposerService, draftIdFor, uploadProgressText } from './composer-service.js'
import { createDialog } from '../../native/ui/dialog.js'
import { attachSheetMotion } from '../../native/ui/composer-morph.js'
import { attachComposerViewport } from '../../native/composer-viewport.js'
import { attachMdToolbar } from '../../native/ui/md-toolbar.js'
import { closeEmojiPanel } from '../../native/ui/emoji-picker.js'
import { formatDuration } from '../../native/media.js'
import { formatVideoBytes, formatVideoElapsed } from '../../native/video-upload.js'
import type { ComposerService, DraftMedia } from './types'

const tools = [
  ['bold', '加粗 (⌘B)', Bold],
  ['italic', '斜体 (⌘I)', Italic],
  ['strikethrough', '删除线', Strikethrough],
  ['heading', '标题', Heading],
  ['quote', '引用', Quote],
  ['code-inline', '行内代码', Code],
  ['code-block', '代码块', SquareCode],
  ['list-ul', '无序列表', List],
  ['list-ol', '有序列表', ListOrdered],
  ['tasklist', '任务列表', ListChecks],
  ['link', '链接 (⌘K)', Link],
  ['emoji', '表情', Smile],
] as const
export default function ComposerDialog({ post, origin }: { post: Post | null; origin: HTMLElement | null }) {
  const { site, closeComposer, changed, toast } = useApp()
  const dialog = useRef<HTMLDialogElement>(null),
    panel = useRef<HTMLDivElement>(null),
    grab = useRef<HTMLButtonElement>(null)
  const close = useRef<() => void>(() => {})
  const [service, setService] = useState<ComposerService | null>(null)
  const callbacks = useRef({ closeComposer, changed, toast })
  callbacks.current = { closeComposer, changed, toast }
  const userId = site.user!.id
  useEffect(() => {
    const current = createComposerService({
      userId,
      post,
      draftId: draftIdFor(userId, post),
      onNotice: (message: string) => callbacks.current.toast(message),
      onPublished: () => {
        callbacks.current.changed()
        callbacks.current.toast(post ? '动态已保存' : '发布成功')
        close.current()
      },
    }) as ComposerService
    setService(current)
    const modal = createDialog(dialog.current!, { onRequestClose: () => close.current() })
    let closing = false
    const finish = () => {
      current.dispose()
      modal.finish()
      callbacks.current.closeComposer()
    }
    modal.open({ source: origin as never })
    const viewport = attachComposerViewport(dialog.current!)
    const motion = attachSheetMotion(panel.current!, dialog.current!, grab.current!, finish, {
      origin: origin as never,
    })
    close.current = () => {
      if (closing || current.getState().busy) return
      closing = true
      closeEmojiPanel(true)
      modal.beginClose()
      motion.close()
    }
    void current.start()
    return () => {
      close.current = () => {}
      current.dispose()
      closeEmojiPanel(true)
      motion.dispose()
      viewport()
      modal.dispose()
    }
  }, [post, origin, userId])
  return (
    <dialog ref={dialog} className="composer-overlay" aria-label={post ? '编辑日常' : '写日常'}>
      <div ref={panel} className="composer-dialog">
        <button ref={grab} className="composer-grab" type="button" aria-label="收起写作面板，也可向下拖动" />
        <button className="composer-close" type="button" aria-label="关闭" onClick={() => close.current()}>
          ×
        </button>
        <div className="composer-body">
          {service && (
            <ComposerForm
              service={service}
              editing={Boolean(post)}
              privateMode={site.privateMode}
              onClose={() => close.current()}
            />
          )}
        </div>
      </div>
    </dialog>
  )
}
function ComposerForm({
  service,
  editing,
  privateMode,
  onClose,
}: {
  service: ComposerService
  editing: boolean
  privateMode: boolean
  onClose: () => void
}) {
  const state = useSyncExternalStore(service.subscribe, service.getState)
  const textarea = useRef<HTMLTextAreaElement>(null),
    toolbar = useRef<HTMLDivElement>(null),
    album = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null),
    result = useRef<HTMLDivElement>(null)
  const resizeDrag = useRef<{ y: number; height: number } | null>(null)
  useEffect(() => attachMdToolbar(toolbar.current!, textarea.current!), [])
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = textarea.current
      if (node?.isConnected && !node.closest('[inert]')) node.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    if (result.current) result.current.scrollTop = result.current.scrollHeight
  }, [state.polish.result])
  const addPickedFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files || [])]
    event.currentTarget.value = ''
    if (files.length) void service.addFiles(files)
  }
  // 仅调整入口展示；iPadOS 桌面标识配合多点触控仍按移动设备处理。
  const mobilePicker =
    /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1)
  const pickerLabel = mobilePicker ? '从相册选择照片或视频' : '选择照片或视频'
  // 桌面唯一入口保留扩展名过滤，兼容系统缺少 HEIC/MOV MIME 映射。
  const pickerAccept = mobilePicker ? 'image/*,video/*' : 'image/*,video/*,.heic,.heif,.avif,.mov,.mp4'
  const guard = service.publishGuard(),
    task = state.imageTask
  const activeTask = Boolean(task && ['queued', 'running', 'uploading'].includes(task.status))
  const adopted = task && state.files.some((file) => file._jobId === task.id)
  return (
    <form
      className="card compose"
      onSubmit={(event) => {
        event.preventDefault()
        void service.publish()
      }}
    >
      <div className="compose-heading">
        <span>{editing ? '编辑这段日常' : '今天，有什么想记住的？'}</span>
        <span className="draft-save-state" aria-live="polite">
          {state.restoring
            ? '正在恢复草稿…'
            : state.saved
              ? '正文已保存到此浏览器'
              : '正文未能保存到此浏览器'}
        </span>
      </div>
      <div ref={toolbar} className="md-toolbar" role="toolbar" aria-label="Markdown 格式">
        {tools.map(([action, label, Icon]) => (
          <button
            type="button"
            key={action}
            data-md={action}
            data-tooltip={label}
            aria-label={label}
            disabled={state.busy}
          >
            <Icon className="icon" />
          </button>
        ))}
        <span className="ai-tools" role="group" aria-label="AI 工具">
          <button
            type="button"
            className="md-polish"
            disabled={state.busy || state.polish.running}
            onClick={() => service.polish()}
          >
            <Sparkles className="icon" />
            <span>{state.polish.running ? '优化中…' : 'AI 优化'}</span>
          </button>
          <button
            type="button"
            className="md-image"
            disabled={state.busy || state.restoring || activeTask || state.imageBusy}
            onClick={() => service.imageAction('start')}
          >
            <Image className="icon" />
            <span>AI 配图</span>
          </button>
        </span>
      </div>
      <div className="editor-box">
        <textarea
          ref={textarea}
          aria-label="动态正文"
          placeholder="一顿晚餐、一场散步，或是突然想说的话…"
          value={state.content}
          disabled={state.busy}
          onInput={(event) => service.set('content', event.currentTarget.value)}
        />
        <div
          className="editor-resize"
          role="separator"
          aria-label="拖动调整编辑框高度"
          tabIndex={0}
          aria-orientation="horizontal"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const node = textarea.current!
            node.style.height = `${Math.max(88, Math.min(innerHeight * 0.75, node.getBoundingClientRect().height + (event.key === 'ArrowDown' ? 20 : -20)))}px`
          }}
          onPointerDown={(event) => {
            event.preventDefault()
            resizeDrag.current = {
              y: event.clientY,
              height: textarea.current!.getBoundingClientRect().height,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (resizeDrag.current)
              textarea.current!.style.height = `${Math.max(88, Math.min(innerHeight * 0.75, resizeDrag.current.height + event.clientY - resizeDrag.current.y))}px`
          }}
          onPointerUp={() => {
            resizeDrag.current = null
          }}
          onPointerCancel={() => {
            resizeDrag.current = null
          }}
        />
      </div>
      {state.polish.open && (
        <div className="ai-compare">
          <div className="ai-compare-head">
            <span className="ai-compare-title">
              <Sparkles className="icon" />
              AI 优化对照
            </span>
            <span className="ai-compare-status" role="status">
              {state.polish.status}
            </span>
            <button
              className="ai-compare-close"
              type="button"
              aria-label="关闭对照"
              onClick={service.closePolish}
            >
              ×
            </button>
          </div>
          <div className="ai-compare-body">
            <section className="ai-pane">
              <h4>原文</h4>
              <div className="ai-pane-text ai-origin">{state.polish.origin}</div>
            </section>
            <section className="ai-pane">
              <h4>AI 优化</h4>
              <div
                ref={result}
                className={`ai-pane-text ai-result${state.polish.running ? ' streaming' : ''}`}
              >
                {state.polish.result}
              </div>
            </section>
          </div>
          <div className="ai-compare-actions">
            <button
              className="btn-ghost"
              type="button"
              disabled={state.polish.running}
              onClick={service.polish}
            >
              重新生成
            </button>
            <span className="spacer" />
            <button className="btn-ghost" type="button" onClick={service.closePolish}>
              {state.polish.running ? '取消' : '保留原文'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={state.polish.running || !state.polish.result.trim()}
              onClick={service.adoptPolish}
            >
              采用优化
            </button>
          </div>
        </div>
      )}
      {(task || state.imageBusy) && (
        <div className="image-job-panel">
          <div className="image-job-head">
            <span className="image-job-title">
              <Image className="icon" />
              AI 配图
            </span>
            <span className="image-job-status" role="status">
              {state.imageBusy
                ? '正在提交…'
                : `${({ queued: '已排队，通常需要 60 秒以上', running: '正在生成，通常需要 60 秒以上', uploading: '正在保存', succeeded: adopted ? '已加入发布内容' : '已完成', failed: '生成失败', cancelled: '已取消' } as Record<string, string>)[task!.status] || task!.status}${task!.error ? `：${task!.error}` : ''}`}
            </span>
          </div>
          {task?.previewUrl && (
            <div className="image-job-preview">
              <img src={task.previewUrl} alt="AI 生成的日记配图" />
            </div>
          )}
          <div className="image-job-actions">
            {task && ['failed', 'cancelled'].includes(task.status) && (
              <button
                type="button"
                className="btn-ghost"
                disabled={state.imageBusy}
                onClick={() => service.imageAction('retry')}
              >
                重新生成
              </button>
            )}
            {task && !adopted && (
              <button
                type="button"
                className="btn-ghost"
                disabled={state.imageBusy}
                onClick={() => service.imageAction('cancel')}
              >
                {activeTask ? '取消任务' : '不使用'}
              </button>
            )}
            {task?.status === 'succeeded' && !adopted && (
              <button type="button" className="btn" onClick={() => service.imageAction('use')}>
                使用这张图
              </button>
            )}
          </div>
        </div>
      )}
      <div className="preview-grid">
        {[...state.keep, ...state.files].map((item) => (
          <Preview key={item._id || item.id} item={item} service={service} busy={state.busy} />
        ))}
      </div>
      {state.cacheWarning && (
        <p className="form-message" data-state="warning" role="status">
          {state.cacheWarning}
        </p>
      )}
      <div className="storage-hint" aria-live="polite">
        {state.files.map((item) => (
          <MediaDetails key={item._id} item={item} service={service} busy={state.busy} />
        ))}
      </div>
      <p className="storage-hint live-photo-help">
        {mobilePicker ? '可从相册选择照片或视频。' : '可选择照片或视频文件。'}
        实况需包含动态资源；系统只提供静态图时无法保留实况效果。
      </p>
      <p className="form-error" role="alert">
        {state.restoreError ? `恢复草稿失败：${state.restoreError}` : state.error}
      </p>
      <div className="compose-actions">
        <button
          className="btn-ghost pick"
          type="button"
          aria-label={pickerLabel}
          title={pickerLabel}
          disabled={state.busy || state.restoring}
          onClick={() => album.current?.click()}
        >
          <Image className="icon" />
        </button>
        {mobilePicker && (
          <button
            className="btn-ghost camera"
            type="button"
            aria-label="调用相机拍照"
            title="拍照"
            disabled={state.busy || state.restoring}
            onClick={() => camera.current?.click()}
          >
            <Camera className="icon" />
          </button>
        )}
        {privateMode && (
          <div className="public-opts">
            <span className="public-opts-tip">
              <Lock className="icon" />
              <span>访客可见</span>
            </span>
            <label className="public-chip">
              <input
                type="checkbox"
                checked={state.publicText}
                disabled={state.busy}
                onChange={(event) => service.set('publicText', event.target.checked)}
              />
              <span>正文</span>
            </label>
            <label className="public-chip">
              <input
                type="checkbox"
                checked={state.publicImages}
                disabled={state.busy}
                onChange={(event) => service.set('publicImages', event.target.checked)}
              />
              <span>图片</span>
            </label>
          </div>
        )}
        <span className="spacer" />
        {editing ? (
          <button className="btn-ghost" type="button" onClick={onClose} disabled={state.busy}>
            取消
          </button>
        ) : (
          <button
            className="btn-ghost discard-draft"
            type="button"
            disabled={state.busy || state.restoring}
            onClick={async () => {
              if (confirm('确定丢弃这篇未发布的草稿吗？') && (await service.discard())) onClose()
            }}
          >
            丢弃草稿
          </button>
        )}
        <button className="btn submit" disabled={Boolean(guard)}>
          {guard || (editing ? '保存' : '发布')}
        </button>
      </div>
      <input
        ref={album}
        className="album-input"
        type="file"
        accept={pickerAccept}
        multiple
        hidden
        disabled={state.busy || state.restoring}
        onChange={addPickedFiles}
      />
      {mobilePicker && (
        <input
          ref={camera}
          className="camera-input"
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          disabled={state.busy || state.restoring}
          onChange={addPickedFiles}
        />
      )}
    </form>
  )
}
function Preview({ item, service, busy }: { item: DraftMedia; service: ComposerService; busy: boolean }) {
  const kind = item._kind || item.type || 'image',
    src = item._url || (kind === 'video' ? item.poster : item.url),
    current = item._status === 'done' && item._motion?._status !== 'done' ? item._motion : item
  return (
    <div className={`preview-item${kind === 'video' ? ' is-video' : ''}${src ? '' : ' no-poster'}`}>
      {src && <img src={src} alt="" />}
      <button
        type="button"
        className="remove"
        aria-label={`移除${item.name || '这项媒体'}`}
        disabled={busy}
        onClick={() => service.remove(item)}
      >
        ×
      </button>
      {kind === 'video' && (
        <>
          <span className="media-play">
            <Play className="icon" />
          </span>
          {(item._duration || item.duration) && (
            <span className="media-duration">{formatDuration(item._duration || item.duration)}</span>
          )}
        </>
      )}
      {(item._motion || item.live) && (
        <span className="media-live">
          <span className="lb-live-dot" />
          LIVE
        </span>
      )}
      {current?._status && current._status !== 'done' ? (
        <div className={`upload-overlay${current._status === 'error' ? ' error' : ''}`}>
          {current._status === 'error' ? (
            current._errMsg || '处理失败'
          ) : (
            <>
              <span className="spinner" />
              <span>{uploadProgressText(current)}</span>
            </>
          )}
        </div>
      ) : (
        item._status === 'done' && (
          <div className="upload-badge">
            <Check className="icon" />
          </div>
        )
      )}
    </div>
  )
}
function MediaDetails({
  item,
  service,
  busy,
}: {
  item: DraftMedia
  service: ComposerService
  busy: boolean
}) {
  const replacement = useRef<HTMLInputElement>(null)
  return (
    <>
      {item._cacheError && (
        <p className="form-message" data-state="warning" role="status">
          {item.name || '照片'}的浏览器媒体缓存失败：{item._cacheError}
          。当前仍可上传；上传完成前关闭或刷新页面，可能需要重新选择原件。
        </p>
      )}
      {Boolean(item._warnings?.length || item._status === 'error' || item._motion) && (
        <div className="live-photo-notice">
          {Boolean(item._warnings?.length) && (
            <p>
              {item.name || '照片'}：{item._warnings?.map((warning) => warning.message).join('；')}
            </p>
          )}
          {item._status === 'error' && (
            <p className="form-error" role="alert">
              {item.name || '媒体'}：{item._errMsg || '处理失败'}
            </p>
          )}
          {item._kind !== 'video' && item._status === 'done' && (item._motion || item._needsReview) && (
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || item._discarding}
              onClick={() => service.keepStill(item)}
            >
              仅保留静态图
            </button>
          )}
          {(item._kind !== 'video' || item._readError) && item._status === 'error' && !item._parsing && (
            <>
              {!item._readError && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => service.retryImage(item)}
                >
                  重试图片
                </button>
              )}
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => replacement.current?.click()}
              >
                重新选择原件
              </button>
              <input
                ref={replacement}
                type="file"
                hidden
                accept={
                  item._readError ? 'image/*,video/*,.heic,.heif,.avif,.mov,.mp4' : 'image/*,.heic,.heif'
                }
                multiple={item._readError}
                disabled={busy}
                onChange={async (event) => {
                  const files = [...(event.target.files || [])]
                  event.target.value = ''
                  if (files.length) {
                    await service.remove(item)
                    await service.addFiles(files)
                  }
                }}
              />
            </>
          )}
        </div>
      )}
      {[item._kind === 'video' && !item._readError ? item : null, item._motion]
        .filter((video): video is DraftMedia => Boolean(video))
        .map((video) => (
          <VideoDetails
            key={video._id}
            item={video}
            service={service}
            needsPoster={video === item}
            busy={busy}
          />
        ))}
    </>
  )
}
function VideoDetails({
  item,
  service,
  needsPoster,
  busy,
}: {
  item: DraftMedia
  service: ComposerService
  needsPoster: boolean
  busy: boolean
}) {
  const result = item._videoResult
  return (
    <div>
      {item._status === 'uploading' && (
        <p>
          {item.name || '视频'}：{uploadProgressText(item)}。原件就绪后即可发布。
        </p>
      )}
      {result?.compressionPending && (
        <p className="storage-hint" role="status">
          原件已保存，可立即发布；{needsPoster ? '压缩在后台继续' : 'Live 实况视频默认在后台压缩'}。
          {uploadProgressText(item)}
        </p>
      )}
      {result?.error && (
        <p
          className="form-message"
          data-state={item._originalReady ? 'warning' : 'error'}
          role={item._originalReady ? 'status' : 'alert'}
        >
          {item._originalReady ? '压缩未完成，仍可发布原件：' : '视频处理失败：'}
          {result.error}
        </p>
      )}
      {item._needsFile ? (
        <label className="btn-ghost">
          选择原件续传
          <input
            type="file"
            hidden
            disabled={busy}
            accept={needsPoster ? 'video/*,.mov,.mp4,.webm' : 'image/*,video/*,.heic,.heif,.mov,.mp4'}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void service.retryVideo(item, file, needsPoster)
            }}
          />
        </label>
      ) : (
        (item._canRetry || (item._status === 'error' && item._file)) && (
          <button
            className="btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => service.retryVideo(item, null, needsPoster)}
          >
            {item._canRetry ? '从检查点重试' : '重试实况视频'}
          </button>
        )
      )}
      {result && ['done', 'error', 'selecting'].includes(item._status || '') && (
        <div className="video-comparison">
          <p>
            {item.name || '视频'}：{result.message}
            {Number.isFinite(result.totalElapsedMs)
              ? ` · 总计 ${formatVideoElapsed(result.totalElapsedMs)}`
              : ''}
          </p>
          {(['original', 'compressed'] as const).map((variant) => {
            const version = result.variants?.[variant],
              label = variant === 'original' ? '原文件' : '压缩版本'
            return (
              version && (
                <p key={variant}>
                  {label}：{formatVideoBytes(version.size)} · {version.codec || '待探测'} ·{' '}
                  {version.width || '?'}×{version.height || '?'} · {Number(version.rate || 0).toFixed(2)}fps ·{' '}
                  {version.bitDepth || '?'}bit · {version.hdr ? 'HDR' : 'SDR'}
                  {result.recommendedVariant === variant ? ' · 推荐' : ''}
                  {result.canSelect &&
                    version.available !== false &&
                    version.codec &&
                    (variant === 'original' || !result.compressionPending) && (
                      <button
                        className="btn-ghost"
                        type="button"
                        disabled={
                          busy ||
                          item._status === 'selecting' ||
                          (result.selectedVariant === variant &&
                            item._status === 'done' &&
                            (result.selectionSource === 'user' || !result.compressionPending))
                        }
                        onClick={() => service.selectVariant(item, variant, needsPoster)}
                      >
                        {result.selectedVariant === variant &&
                        item._status === 'done' &&
                        (result.selectionSource === 'user' || !result.compressionPending)
                          ? '已采用'
                          : `采用${label}`}
                      </button>
                    )}
                </p>
              )
            )
          })}
          {result.comparison?.compressed && (
            <p>
              {result.comparison.savingPercent >= 0 ? '节省' : '增大'}{' '}
              {Math.abs(result.comparison.savingPercent).toFixed(1)}% · 压缩后/原件{' '}
              {(result.comparison.compressionRatio * 100).toFixed(1)}%。{result.comparison.changes.join('；')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
