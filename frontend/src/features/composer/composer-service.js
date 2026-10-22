import { api, streamSse, formatBytes } from '../../native/utils.js'
import { createDraftStorage } from '../../native/features/composer/draft-storage.js'
import { normalizeMediaFiles } from '../../native/live-photo.js'
import { isVideoFile, readVideoPoster } from '../../native/media.js'
import {
  uploadVideo,
  waitForVideoUpload,
  cancelVideoUpload,
  retryVideoUpload,
  selectVideoVariant,
  formatVideoElapsed,
} from '../../native/video-upload.js'
import { prepareImage } from './image-processing.js'

export const newDraftId = () =>
  globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
export function draftIdFor(userId, post) {
  if (post) return `post-${post.id}`
  const key = `compose-draft-id:${location.origin}:${userId}`
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = newDraftId()
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return newDraftId()
  }
}
const pendingStates = ['processing', 'uploading', 'selecting']
const activeImage = (task) => task && ['queued', 'running', 'uploading'].includes(task.status)
const preview = (draftId, name) =>
  name ? `/api/drafts/${encodeURIComponent(draftId)}/preview/${encodeURIComponent(name)}` : ''

// 只管理业务状态和资源，页面与 DOM 由 React 独占。卸载不代表丢弃远端草稿。
export function createComposerService({
  userId,
  post,
  draftId,
  onNotice = (_message) => {},
  onPublished = (_result) => {},
  request = api,
  storage: providedStorage = null,
}) {
  const listeners = new Set(),
    controllers = new Set(),
    videos = new Map()
  let disposed = false,
    finished = false,
    ready,
    imageTimer,
    polishController,
    polishTimer
  const storage =
    providedStorage ||
    createDraftStorage(
      () => userId,
      (saved) => {
        state.saved = saved
        emit(false)
      },
    )
  const saved = storage.readComposeState(draftId) || {}
  let state = {
    content: typeof saved.content === 'string' ? saved.content : post?.content || '',
    publicText: saved.publicText ?? Boolean(post?.public_text),
    publicImages: saved.publicImages ?? Boolean(post?.public_images),
    files: [],
    keep: (post?.images || []).filter((image) => !Array.isArray(saved.keep) || saved.keep.includes(image.id)),
    restoring: true,
    restoreError: '',
    error: '',
    saved: true,
    busy: false,
    imageTask: null,
    imageBusy: false,
    imageJobId: saved.imageJobId || '',
    polish: { open: false, running: false, origin: '', result: '', status: '' },
  }
  let snapshot = { ...state }
  const encode = encodeURIComponent
  function emit(persist = true) {
    if (disposed) return
    if (persist) persistDraft()
    snapshot = { ...state, files: [...state.files], keep: [...state.keep], polish: { ...state.polish } }
    for (const listener of listeners) listener()
  }
  function serialize() {
    return {
      content: state.content,
      publicText: state.publicText,
      publicImages: state.publicImages,
      keep: state.keep.map((item) => item.id),
      imageJobId: state.imageJobId,
      files: state.files
        .filter((file) => !file._parsing)
        .map((file) => ({
          id: file._id,
          name: file.name || '',
          type: file.type || '',
          status: file._status,
          filename: file._name || '',
          jobId: file._jobId || '',
          kind: file._kind || 'image',
          poster: file._poster || '',
          duration: file._duration || null,
          motion: file._motion?._name || '',
          motionStatus: file._motion?._status || '',
          videoJobId: file._videoJobId || '',
          videoResult: file._videoResult || null,
          clientUploadId: file._clientUploadId || '',
          fingerprint: file._fingerprint || '',
          motionJobId: file._motion?._videoJobId || '',
          motionResult: file._motion?._videoResult || null,
          motionClientUploadId: file._motion?._clientUploadId || '',
          motionFingerprint: file._motion?._fingerprint || '',
          source: file._source || null,
          warnings: file._warnings || [],
          needsReview: Boolean(file._needsReview),
          motionName: file._motion?.name || '',
          error: file._errMsg || '',
        })),
    }
  }
  function persistDraft() {
    if (!disposed && !finished && !state.restoring && !state.restoreError)
      storage.saveComposeState(draftId, serialize())
  }
  const fail = (error) => {
    if (!disposed) {
      state.error = error.message || String(error)
      emit(false)
    } else onNotice(error.message || String(error))
  }
  const controller = () => {
    const current = new AbortController()
    controllers.add(current)
    return current
  }
  async function removeCached(id) {
    try {
      await storage.removeDraftFile(draftId, id)
    } catch (error) {
      fail(new Error(`浏览器草稿缓存清理失败：${error.message}`))
    }
  }
  function applyVideo(item, result, needsPoster) {
    item._name = result.filename
    item._duration = result.duration
    item._videoResult = result
    if (needsPoster && result.poster) {
      revoke(item)
      item._poster = result.poster
      item._url = preview(draftId, result.poster)
    }
    item._status = 'done'
    item._progress = null
    item._needsFile = false
    item._canRetry = false
    item._errMsg = ''
  }
  function revoke(item) {
    for (const url of [item._url, item._posterUrl]) if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    item._posterUrl = ''
  }
  async function runVideo(item, source, needsPoster) {
    if (disposed || item._removed || videos.has(item)) return
    const current = controller()
    videos.set(item, current)
    item._status = 'uploading'
    item._needsFile = false
    item._canRetry = false
    item._errMsg = ''
    emit()
    let lastPaint = 0
    try {
      await ready
      current.signal.throwIfAborted()
      const options = {
        draftId,
        needsPoster,
        signal: current.signal,
        uploadId: item._videoJobId || '',
        clientUploadId: item._clientUploadId || '',
        fingerprint: item._fingerprint || '',
        onState: (next) => {
          if (disposed || item._removed) return
          const identityChanged =
            (next.uploadId && next.uploadId !== item._videoJobId) ||
            (next.clientUploadId && next.clientUploadId !== item._clientUploadId) ||
            (next.fingerprint && next.fingerprint !== item._fingerprint)
          if (next.uploadId) item._videoJobId = next.uploadId
          if (next.clientUploadId) item._clientUploadId = next.clientUploadId
          if (next.fingerprint) item._fingerprint = next.fingerprint
          if (next.variants?.original) item._videoResult = next
          item._progress = { ...next, loaded: next.loaded ?? next.received ?? 0 }
          if (next.duration) item._duration = next.duration
          if (identityChanged) persistDraft()
          if (performance.now() - lastPaint >= 100) {
            lastPaint = performance.now()
            emit(false)
          }
        },
      }
      const result = source
        ? await uploadVideo(source, options)
        : await waitForVideoUpload(item._videoJobId, options)
      if (disposed || item._removed) return
      applyVideo(item, result, needsPoster)
      if (item._parent?._status === 'done' && !item._parent._needsReview) await removeCached(item._parent._id)
    } catch (error) {
      if (!disposed && !item._removed) {
        item._status = 'error'
        item._errMsg = error.message || '视频处理失败'
        item._needsFile = Boolean(error.needsFile)
        item._canRetry = Boolean(error.canRetry)
      }
    } finally {
      controllers.delete(current)
      videos.delete(item)
      if (!disposed && !item._removed) emit()
    }
  }
  const makeMotion = (parent, file) => ({
    _id: newDraftId(),
    name: file.name,
    _status: 'processing',
    _parent: parent,
    _file: file,
  })
  async function processImage(item) {
    if (disposed || item._removed) return
    item._kind = 'image'
    item._status = 'processing'
    emit()
    const current = controller()
    try {
      const original = item instanceof Blob ? item : item._originalFile
      if (!(original instanceof Blob)) throw new Error('请重新选择原始照片继续处理')
      original._id = item._id
      await storage.saveDraftFile(draftId, original)
      if (disposed || item._removed) return
      const compressed = await prepareImage(item._uploadStill || original)
      if (disposed || item._removed) return
      revoke(item)
      item._url = URL.createObjectURL(compressed)
      item._status = 'uploading'
      emit()
      await ready
      current.signal.throwIfAborted()
      const form = new FormData()
      form.append('image', compressed)
      form.append('draftId', draftId)
      const result = await request('/api/uploads', { method: 'POST', body: form, signal: current.signal })
      if (item._removed) {
        await request(`/api/uploads/${encode(result.filename)}`, { method: 'DELETE' })
        return
      }
      if (disposed) return
      item._name = result.filename
      item._status = 'done'
      item._errMsg = ''
      if (!item._needsReview && (!item._motion || item._motion._status === 'done'))
        await removeCached(item._id)
    } catch (error) {
      if (!disposed && !item._removed) {
        item._status = 'error'
        item._errMsg = error.message || '图片处理失败'
      }
    } finally {
      controllers.delete(current)
      if (!disposed && !item._removed) emit()
    }
  }
  async function processVideo(item) {
    try {
      const { duration, poster } = await readVideoPoster(item)
      if (disposed || item._removed) return
      item._duration = duration
      if (poster) item._url = item._posterUrl = URL.createObjectURL(poster)
    } catch {
      /* 浏览器无法解码时，交由服务端生成正式封面。 */
    }
    if (!disposed && !item._removed) await runVideo(item, item, true)
  }
  async function resumeMotion(parent, selected) {
    try {
      let motion = selected
      if (!isVideoFile(selected)) {
        const [group] = await normalizeMediaFiles([selected])
        if (!group?.motion) throw new Error('此原件没有可提取的完整实况视频')
        motion = group.motion
      }
      if (disposed || parent._removed || !parent._motion) return
      parent._motion._file = motion
      await runVideo(parent._motion, motion, false)
    } catch (error) {
      fail(error)
    }
  }
  async function restore() {
    const current = controller()
    try {
      ready = request('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: draftId, postId: post?.id || null }),
        signal: current.signal,
      })
      await ready
      const remote = await request(`/api/drafts/${encode(draftId)}`, { signal: current.signal })
      if (disposed) return
      if (remote.draft?.status === 'published' && !post)
        throw new Error('这份草稿已发布，请丢弃本地副本后开始新的日常')
      const jobs = new Map((remote.videoJobs || []).map((job) => [job.uploadId, job]))
      for (const entry of Array.isArray(saved.files) ? saved.files : []) {
        const kind = entry.kind || 'image'
        const item = {
          _id: entry.id || newDraftId(),
          name: entry.name || '',
          type: entry.type || '',
          _kind: kind,
          _name: entry.filename || '',
          _status: entry.filename ? 'done' : 'error',
          _jobId: entry.jobId || '',
          _url: preview(draftId, kind === 'video' ? entry.poster : entry.filename),
          _poster: entry.poster || '',
          _duration: entry.duration,
          _videoJobId: entry.videoJobId || '',
          _videoResult: entry.videoResult || null,
          _clientUploadId: entry.clientUploadId || '',
          _fingerprint: entry.fingerprint || '',
          _source: entry.source || null,
          _warnings: entry.warnings || [],
          _needsReview: Boolean(entry.needsReview),
          _errMsg: entry.error || (entry.filename ? '' : '请重新选择原件继续处理'),
        }
        state.files.push(item)
        if (entry.motion || entry.motionJobId || entry.motionStatus)
          item._motion = {
            _id: newDraftId(),
            _parent: item,
            name: entry.motionName || '实况视频',
            _name: entry.motion || '',
            _status: entry.motion ? 'done' : 'error',
            _videoJobId: entry.motionJobId || '',
            _videoResult: entry.motionResult || null,
            _clientUploadId: entry.motionClientUploadId || '',
            _fingerprint: entry.motionFingerprint || '',
          }
        for (const video of [kind === 'video' ? item : null, item._motion].filter(Boolean)) {
          const job = jobs.get(video._videoJobId),
            poster = video === item
          if (job?.status === 'done') applyVideo(video, job, poster)
          else if (video._videoJobId && (!video._name || job)) void runVideo(video, null, poster)
          else if (!video._name) {
            video._needsFile = true
            video._status = 'error'
            video._errMsg = '选择原件续传'
          }
        }
      }
      const restored = new Set(state.files.flatMap((item) => [item._videoJobId, item._motion?._videoJobId]))
      for (const job of jobs.values()) {
        if (
          !job.needsPoster ||
          restored.has(job.uploadId) ||
          job.status === 'cancelled' ||
          state.keep.some((image) => image.url === `/uploads/${job.filename}`)
        )
          continue
        const item = {
          _id: newDraftId(),
          _kind: 'video',
          _videoJobId: job.uploadId,
          name: job.name || '视频',
          _status: 'uploading',
        }
        state.files.push(item)
        if (job.status === 'done') applyVideo(item, job, true)
        else void runVideo(item, null, true)
      }
      const blobs = await storage.loadDraftFiles(draftId)
      for (const blob of blobs) {
        if (disposed) return
        const item = state.files.find((file) => file._id === blob._id)
        if (item?._name) {
          item._originalFile = blob
          if (item._motion?._needsFile && item._source?.pairing === 'embedded') void resumeMotion(item, blob)
          continue
        }
        const [group] = await normalizeMediaFiles([blob], { signal: current.signal })
        if (disposed) return
        const restoredItem = item || blob
        restoredItem._originalFile = blob
        restoredItem._uploadStill = group.still
        restoredItem._source ||= group.source
        restoredItem._warnings ||= group.warnings
        restoredItem._needsReview ??= group.warnings.some((warning) => warning.blocking)
        if (!item) state.files.push(restoredItem)
        if (group.motion && !restoredItem._motion && restoredItem._source?.pairing !== 'static')
          restoredItem._motion = makeMotion(restoredItem, group.motion)
        void processImage(restoredItem)
        if (
          group.motion &&
          restoredItem._motion &&
          (!restoredItem._motion._videoJobId || restoredItem._motion._needsFile)
        )
          void runVideo(restoredItem._motion, group.motion, false)
      }
      if (state.imageJobId) void refreshImage()
    } catch (error) {
      if (!disposed) state.restoreError = error.message || '媒体恢复失败'
    } finally {
      controllers.delete(current)
      if (!disposed) {
        state.restoring = false
        emit()
      }
    }
  }
  async function addFiles(picked) {
    if (!picked.length || disposed || state.busy || state.restoring || state.restoreError) return
    const current = controller(),
      placeholder = {
        _id: newDraftId(),
        name: `解析 ${picked.length} 个文件`,
        _parsing: true,
        _status: 'processing',
        _kind: 'image',
        _parseController: current,
      }
    state.files.push(placeholder)
    emit(false)
    try {
      for (const original of picked) {
        if (isVideoFile(original)) continue
        original._id ||= newDraftId()
        await storage.saveDraftFile(draftId, original)
      }
      const groups = await normalizeMediaFiles(picked, { signal: current.signal })
      if (disposed || placeholder._removed) return
      state.files = state.files.filter((item) => item !== placeholder)
      for (const group of groups) {
        const item = group.original || group.video || group.still
        item._id ||= newDraftId()
        item._source = group.source
        item._warnings = group.warnings
        item._needsReview = group.kind !== 'video' && group.warnings.some((warning) => warning.blocking)
        item._status = 'processing'
        item._kind = group.video ? 'video' : 'image'
        item._uploadStill = group.still
        if (group.motion) item._motion = makeMotion(item, group.motion)
        state.files.push(item)
        if (group.video) void processVideo(item)
        else void processImage(item)
        if (group.motion) void runVideo(item._motion, group.motion, false)
      }
    } catch (error) {
      if (!disposed && !current.signal.aborted) {
        placeholder._status = 'error'
        placeholder._errMsg = error.message
        fail(error)
      }
    } finally {
      controllers.delete(current)
      if (placeholder._removed) for (const original of picked) await removeCached(original._id)
      emit()
    }
  }
  async function remove(item) {
    if (state.busy || disposed) return
    if (state.keep.includes(item)) {
      state.keep = state.keep.filter((image) => image !== item)
      emit()
      return
    }
    item._removed = true
    item._parseController?.abort()
    const cleanup = []
    for (const video of [item, item._motion].filter(Boolean)) {
      video._removed = true
      videos.get(video)?.abort()
      if (video._videoJobId) cleanup.push(cancelVideoUpload(video._videoJobId))
      else if (video._name) cleanup.push(request(`/api/uploads/${encode(video._name)}`, { method: 'DELETE' }))
    }
    if (item._jobId) cleanup.push(request(`/api/image-jobs/${encode(item._jobId)}`, { method: 'DELETE' }))
    if (item._poster && !item._videoJobId)
      cleanup.push(request(`/api/uploads/${encode(item._poster)}`, { method: 'DELETE' }))
    revoke(item)
    state.files = state.files.filter((file) => file !== item)
    emit()
    const results = await Promise.allSettled([...cleanup, removeCached(item._id)])
    for (const result of results)
      if (result.status === 'rejected') fail(new Error(`媒体已移除，但清理失败：${result.reason.message}`))
  }
  async function keepStill(item) {
    if (disposed || state.busy || item._discarding) return
    const motion = item._motion
    item._discarding = true
    state.error = ''
    emit()
    try {
      if (motion) {
        motion._removed = true
        videos.get(motion)?.abort()
        if (motion._videoJobId) await cancelVideoUpload(motion._videoJobId)
        else if (motion._name) await request(`/api/uploads/${encode(motion._name)}`, { method: 'DELETE' })
      }
      if (disposed || item._removed) return
      item._motion = null
      item._needsReview = false
      item._source = { ...item._source, pairing: 'static' }
      item._warnings = [{ code: 'STATIC_ONLY', message: '已选择仅保留静态图', blocking: false }]
      await removeCached(item._id)
    } catch (error) {
      if (motion) {
        motion._removed = false
        motion._status = 'error'
        motion._errMsg = error.message
      }
      fail(new Error(`仅保留静态图失败：${error.message}`))
    } finally {
      item._discarding = false
      emit()
    }
  }
  async function retryVideo(item, source, needsPoster) {
    if (source) return needsPoster ? runVideo(item, source, true) : resumeMotion(item._parent, source)
    try {
      if (item._canRetry) await retryVideoUpload(item._videoJobId)
      await runVideo(item, item._file || null, needsPoster)
    } catch (error) {
      fail(error)
    }
  }
  async function selectVariant(item, variant, needsPoster) {
    if (disposed || state.busy || item._status === 'selecting') return
    const previous = item._status
    item._status = 'selecting'
    emit()
    try {
      const result = await selectVideoVariant(item._videoJobId, variant)
      if (!disposed && !item._removed) applyVideo(item, result, needsPoster)
    } catch (error) {
      item._status = previous
      fail(error)
    } finally {
      emit()
    }
  }
  async function refreshImage() {
    clearTimeout(imageTimer)
    const id = state.imageJobId
    if (!id || disposed) return
    try {
      const result = await request(`/api/image-jobs/${encode(id)}`)
      if (disposed || state.imageJobId !== id) return
      state.imageTask = result.task
      emit()
    } catch (error) {
      fail(error)
    }
    if (!disposed && activeImage(state.imageTask)) imageTimer = setTimeout(refreshImage, 3000)
  }
  async function imageAction(kind) {
    if (disposed || state.imageBusy || state.busy) return
    if (kind === 'use') {
      const task = state.imageTask
      if (task?.status === 'succeeded' && !state.files.some((file) => file._jobId === task.id))
        state.files.push({
          _id: newDraftId(),
          _jobId: task.id,
          _name: task.filename,
          _url: task.previewUrl,
          _status: 'done',
          _kind: 'image',
          name: 'AI 配图',
          type: task.mime || 'image/png',
        })
      emit()
      return
    }
    if (kind === 'start' && !state.content.trim()) {
      fail(new Error('先写点内容再生成配图'))
      return
    }
    state.imageBusy = true
    state.error = ''
    emit(false)
    try {
      await ready
      const id = state.imageJobId
      const url =
        kind === 'start'
          ? '/api/image-jobs'
          : `/api/image-jobs/${encode(id)}${kind === 'retry' ? '/retry' : ''}`
      const result = await request(url, {
        method: kind === 'cancel' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: kind === 'start' ? JSON.stringify({ draftId, text: state.content.trim() }) : undefined,
      })
      if (disposed) {
        if (result.task?.id) await request(`/api/image-jobs/${encode(result.task.id)}`, { method: 'DELETE' })
        return
      }
      state.imageJobId = result.task?.id || id
      state.imageTask = result.task || state.imageTask
      await refreshImage()
    } catch (error) {
      fail(error)
    } finally {
      state.imageBusy = false
      emit()
    }
  }
  function closePolish() {
    polishController?.abort()
    clearInterval(polishTimer)
    state.polish.open = false
    state.polish.running = false
    emit(false)
  }
  async function polish() {
    if (state.polish.running || disposed) return
    const text = state.content.trim()
    if (!text) {
      fail(new Error('先写点内容再优化'))
      return
    }
    const current = new AbortController()
    polishController = current
    state.error = ''
    state.polish = { open: true, running: true, origin: text, result: '', status: '思考中…0s' }
    emit(false)
    const started = Date.now()
    let thinking = 0,
      gotContent = false
    const tick = () => {
      if (!gotContent) {
        state.polish.status = thinking
          ? `思考中…（${thinking} 字）`
          : `思考中…${Math.floor((Date.now() - started) / 1000)}s`
        emit(false)
      }
    }
    polishTimer = setInterval(tick, 500)
    try {
      await streamSse(
        '/api/llm/polish',
        { text },
        (event) => {
          if (current.signal.aborted || disposed) return
          if (event.reasoning) {
            thinking += event.reasoning.length
            tick()
          }
          if (event.delta) {
            gotContent = true
            state.polish.result += event.delta
            state.polish.status = '生成中…'
            emit(false)
          }
        },
        current.signal,
      )
      state.polish.status = state.polish.result.trim() ? '已完成，可对照后决定是否采用' : 'AI 未返回有效结果'
    } catch (error) {
      if (!current.signal.aborted) {
        if (error.code === 'LLM_NOT_CONFIGURED') location.hash = '#/settings/ai'
        fail(error)
      }
    } finally {
      if (polishController === current) {
        clearInterval(polishTimer)
        polishController = null
        state.polish.running = false
        emit(false)
      }
    }
  }
  function publishGuard() {
    if (state.restoreError) return '恢复失败，请重新打开编辑器'
    if (state.busy) return '正在保存…'
    if (state.restoring) return '正在恢复草稿…'
    if (
      state.files.some(
        (file) =>
          file._status === 'error' ||
          file._needsReview ||
          file._discarding ||
          file._motion?._status === 'error',
      )
    )
      return '请处理失败或待确认的媒体'
    if (
      state.files.some(
        (file) => pendingStates.includes(file._status) || pendingStates.includes(file._motion?._status),
      )
    )
      return '媒体处理中…'
    if (state.imageBusy || activeImage(state.imageTask)) return 'AI 配图处理中…'
    return ''
  }
  async function publish() {
    if (publishGuard() || disposed) return
    const content = state.content.trim()
    if (!content && !state.files.length && !state.keep.length) {
      fail(new Error('写点什么或传张图吧'))
      return
    }
    state.busy = true
    state.error = ''
    emit(false)
    try {
      await ready
      const body = {
        content,
        draftId,
        images: state.files.map((file) => ({
          filename: file._name,
          ...(file._motion?._name ? { motion: file._motion._name } : {}),
          ...(file._poster ? { poster: file._poster } : {}),
          ...(file._duration ? { duration: file._duration } : {}),
        })),
        publicText: state.publicText,
        publicImages: state.publicImages,
        ...(post ? { keep: state.keep.map((image) => image.id) } : {}),
      }
      const result = await request(post ? `/api/posts/${post.id}` : '/api/posts', {
        method: post ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      finished = true
      state.busy = false
      emit(false)
      storage.clearComposeState(draftId)
      if (!post)
        try {
          localStorage.removeItem(`compose-draft-id:${location.origin}:${userId}`)
        } catch {
          /* 存储拒绝不改变发布结果。 */
        }
      onPublished(result)
      try {
        await storage.clearDraftFiles(draftId)
      } catch (error) {
        onNotice(`已发布，但浏览器草稿缓存清理失败：${error.message}`)
      }
    } catch (error) {
      fail(error)
    } finally {
      state.busy = false
      emit(false)
    }
  }
  async function discard() {
    if (state.busy || disposed) return false
    state.busy = true
    state.error = ''
    emit(false)
    try {
      await ready
      await request(`/api/drafts/${encode(draftId)}`, { method: 'DELETE' })
      finished = true
      storage.clearComposeState(draftId)
      try {
        localStorage.removeItem(`compose-draft-id:${location.origin}:${userId}`)
      } catch {
        /* 远端删除已完成。 */
      }
      try {
        await storage.clearDraftFiles(draftId)
      } catch (error) {
        onNotice(`草稿已丢弃，但浏览器缓存清理失败：${error.message}`)
      }
      return true
    } catch (error) {
      fail(error)
      return false
    } finally {
      state.busy = false
      emit(false)
    }
  }
  function dispose() {
    if (disposed) return
    persistDraft()
    disposed = true
    window.removeEventListener('pagehide', persistDraft)
    clearTimeout(imageTimer)
    clearInterval(polishTimer)
    polishController?.abort()
    for (const current of controllers) current.abort()
    for (const item of state.files) revoke(item)
    controllers.clear()
    videos.clear()
    listeners.clear()
    if (!finished && state.imageJobId && !state.files.some((file) => file._jobId === state.imageJobId))
      void request(`/api/image-jobs/${encode(state.imageJobId)}`, { method: 'DELETE' }).catch((error) =>
        onNotice(`取消未采用的配图失败：${error.message}`),
      )
  }
  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      window.addEventListener('pagehide', persistDraft)
      return restore()
    },
    dispose,
    set(field, value) {
      if (!disposed && !state.busy) {
        state[field] = value
        emit()
      }
    },
    addFiles,
    remove,
    keepStill,
    retryImage: processImage,
    retryVideo,
    selectVariant,
    imageAction,
    polish,
    closePolish,
    adoptPolish() {
      if (!state.polish.running && state.polish.result.trim()) {
        state.content = state.polish.result.trim()
        closePolish()
        emit()
      }
    },
    publishGuard,
    publish,
    discard,
  }
}

export function uploadProgressText(item) {
  const progress = item._progress
  const labels = {
    hashing: '校验原文件',
    connection: '等待网络恢复',
    receiving: '接收原文件',
    queued: '原件已接收，等待处理',
    verifying_source: '验证原文件',
    saving_original: '保存原文件',
    probing: '读取视频信息',
    planning: '建立检查点',
    audio: '处理音轨',
    merging: '合并视频',
    comparing: '对比两份版本',
    saving_compressed: '保存压缩版本',
    compressing: '压缩中',
    remuxing: '优化视频封装',
    validating: '校验压缩结果',
    poster: '生成视频封面',
    registering: '登记视频结果',
    saving: '保存中',
    waiting: '处理已暂停',
  }
  if (progress && labels[progress.phase]) {
    if (['compressing', 'remuxing'].includes(progress.phase))
      return `${labels[progress.phase]} ${Math.floor(progress.progress || 0)}% · ${Number.isFinite(progress.estimatedRemainingMs) ? `预计剩余约 ${formatVideoElapsed(progress.estimatedRemainingMs)}` : '预计时间计算中…'}`
    return labels[progress.phase]
  }
  if (progress?.total > 0) return `上传中 ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
  return item._status === 'processing' ? '处理中' : '上传中'
}
