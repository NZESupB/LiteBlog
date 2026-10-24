// 视频分片续传与任务恢复；草稿保存身份信息，不缓存大视频原件。
import { api } from '../lib/api'
import { uploadWithProgress } from './utils.js'
import { videoContentType } from './media.js'
function wait(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || new DOMException('等待已停止', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
const retryable = (error) => error.name !== 'AbortError' && (!error.status || [408, 429, 500, 502, 503, 504].includes(error.status))
async function connected(task, { signal, onState, state = {} }) {
  let attempts = 0
  for (;;) {
    signal?.throwIfAborted()
    try { return await task() } catch (error) {
      if (!retryable(error)) throw error
      onState?.({ ...state, phase: 'connection', connectionError: error.message })
      await wait(Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)), signal)
    }
  }
}
function identify(file, chunkBytes, signal, onProgress) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./video-fingerprint-worker.js', import.meta.url), { type: 'module' })
    const finish = (callback, value) => { worker.terminate(); signal?.removeEventListener('abort', abort); callback(value) }
    const abort = () => finish(reject, signal.reason || new DOMException('校验已停止', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => finish(reject, new Error(event.message || '文件身份校验失败'))
    worker.onmessage = ({ data }) => {
      if (data.error) finish(reject, new Error(data.error))
      else if (data.identity) finish(resolve, data.identity)
      else onProgress?.(data.loaded)
    }
    worker.postMessage({ file, chunkBytes })
  })
}
export function formatVideoElapsed(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60)
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${seconds % 60}秒`
}
export function formatVideoBytes(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / 1e6
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)}GB` : `${mb < 10 ? mb.toFixed(2) : mb.toFixed(1)}MB`
}
export const getVideoUploadConfig = (signal) => api('/api/uploads/video/config', { signal })
export async function cancelVideoUpload(id) {
  try { return await api(`/api/uploads/video/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
  catch (error) { if (error.status !== 404) throw error }
}
export const retryVideoUpload = (id, signal) => api(`/api/uploads/video/${encodeURIComponent(id)}/resume`, { method: 'POST', signal })
export const selectVideoVariant = (id, variant, signal) => api(`/api/uploads/video/${encodeURIComponent(id)}/select`, {
  method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant }),
})
export async function waitForVideoUpload(id, { signal, onState, waitForCompression = false } = {}) {
  const url = `/api/uploads/video/${encodeURIComponent(id)}`
  let state = { uploadId: id }
  for (;;) {
    state = await connected(() => api(url, { signal }), { signal, onState, state })
    onState?.(state)
    if (state.status === 'done' && state.filename) return state
    if (!waitForCompression && state.originalReady && state.filename && state.status !== 'cancelled') return state
    if (state.status === 'failed') throw new Error(state.error || '视频处理失败')
    if (state.status === 'cancelled') throw new Error('视频任务已取消')
    if (state.retryable) throw Object.assign(new Error(state.error || '处理暂停，可从检查点重试'), { canRetry: true })
    if (state.status === 'receiving') {
      if (state.total > 0 && state.received === state.total) await connected(() => api(`${url}/complete`, { method: 'POST', signal }), { signal, onState, state })
      else throw Object.assign(new Error('选择原始视频继续上传，已接收部分会保留 24 小时'), { needsFile: true })
    }
    await wait(1000, signal)
  }
}
export async function uploadVideo(file, { draftId, needsPoster = true, livePhoto = false, signal, onState, uploadId = '', clientUploadId = '', fingerprint = '' } = {}) {
  const config = await connected(() => getVideoUploadConfig(signal), { signal, onState })
  if (!config.available) throw new Error(config.error || '视频处理工具不可用')
  if (file.size > config.maxBytes) throw new Error(`原视频不能超过 ${formatVideoBytes(config.maxBytes)}`)
  clientUploadId ||= globalThis.crypto?.randomUUID?.() || `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const metadata = { uploadId, clientUploadId, total: file.size, status: 'receiving', phase: 'hashing' }
  onState?.(metadata)
  const identity = await identify(file, config.chunkBytes, signal, (loaded) => onState?.({ ...metadata, loaded }))
  if (fingerprint && fingerprint !== identity.fingerprint) throw Object.assign(new Error('文件内容不同，请选择原始视频继续上传'), { needsFile: true })
  const body = { ...identity, draftId, needsPoster, livePhoto, clientUploadId, contentType: videoContentType(file), name: file.name }
  let state = uploadId
    ? await connected(() => api(`/api/uploads/video/${encodeURIComponent(uploadId)}/resume`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { signal, onState, state: metadata })
    : await connected(() => api('/api/uploads/video/init', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { signal, onState, state: metadata })
  const id = state.uploadId, url = `/api/uploads/video/${encodeURIComponent(id)}`
  onState?.({ ...state, clientUploadId, fingerprint: identity.fingerprint })
  if (state.status !== 'receiving') return state.status === 'done' ? state : waitForVideoUpload(id, { signal, onState })
  while (state.received < file.size) {
    const start = state.received, end = Math.min(file.size, start + config.chunkBytes)
    try {
      state = await uploadWithProgress(`${url}/chunk?offset=${start}`, file.slice(start, end), {
        headers: { 'Content-Type': 'application/octet-stream' }, signal, timeout: 120000,
        onProgress: ({ loaded }) => onState?.({ ...state, phase: 'uploading', loaded: start + loaded }),
      })
    } catch (error) {
      if (!retryable(error) && error.status !== 409) throw error
      state = await connected(() => api(url, { signal }), { signal, onState, state })
      if (state.received === start && error.status === 409) throw error
      if (state.received === start) await wait(2000, signal)
    }
    if (!Number.isSafeInteger(state.received) || state.received < start || state.received > file.size) throw new Error('服务器上传偏移无效')
    if (state.status === 'failed' || state.status === 'cancelled') throw new Error(state.error || '任务已停止')
    onState?.(state)
  }
  if (state.status === 'receiving') state = await connected(() => api(`${url}/complete`, { method: 'POST', signal }), { signal, onState, state })
  return state.status === 'done' ? state : waitForVideoUpload(id, { signal, onState })
}
