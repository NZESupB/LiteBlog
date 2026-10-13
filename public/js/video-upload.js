// 视频分片上传与后台任务轮询；草稿仅记录任务 ID，不缓存大视频原件。
import { api, uploadWithProgress } from '/js/utils.js'
import { videoContentType } from '/js/media.js'

function wait(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('等待已取消', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
const retryable = (error) => error.name !== 'AbortError' && (!error.status || [408, 409, 429, 500, 502, 503, 504].includes(error.status))
async function retry(task, signal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try { return await task() } catch (error) {
      if (attempt >= 3 || !retryable(error)) throw error
      await wait(500 * 2 ** attempt, signal)
    }
  }
}
export function formatVideoElapsed(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}${seconds % 60}秒`
}
export const getVideoUploadConfig = (signal) => api('/api/uploads/video/config', { signal })
export async function cancelVideoUpload(id) {
  try { return await api(`/api/uploads/video/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
  catch (error) { if (error.status !== 404) throw error }
}
export async function waitForVideoUpload(id, { signal, onState, onDecision } = {}) {
  const url = `/api/uploads/video/${encodeURIComponent(id)}`
  const deadline = Date.now() + 6 * 60 * 60 * 1000
  while (Date.now() < deadline) {
    const state = await retry(() => api(url, { signal }), signal)
    onState?.(state)
    if (state.status === 'done' && state.filename) return state
    if (state.status === 'failed') throw new Error(state.error || '视频压缩或保存失败')
    if (state.status === 'cancelled') throw new Error('视频任务已取消，请重新选择视频')
    // 原件已完整接收：先让用户决定是否压缩；没有决策入口时按默认压缩继续。
    if (state.status === 'awaiting') {
      const choice = onDecision ? await onDecision(state) : 'compress'
      await retry(() => api(`${url}/decision`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepOriginal: choice === 'original' }) }), signal)
    }
    if (state.status === 'receiving') {
      if (state.total > 0 && state.received === state.total) await retry(() => api(`${url}/complete`, { method: 'POST', signal }), signal)
      else throw new Error('原视频尚未完整上传，请移除这项并重新选择视频')
    }
    await wait(1000, signal)
  }
  throw new Error('视频仍在后台处理，请稍后重新打开草稿查看')
}
export async function uploadVideo(file, { draftId, needsPoster = true, signal, onState, onDecision } = {}) {
  const config = await getVideoUploadConfig(signal)
  if (!config.available) throw new Error(config.error || '视频处理工具不可用')
  if (file.size > config.maxBytes) throw new Error(`原视频不能超过 ${Math.round(config.maxBytes / 1024 / 1024)}MiB`)
  const initialized = await api('/api/uploads/video/init', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, contentType: videoContentType(file), size: file.size, needsPoster, name: file.name }),
  })
  const id = initialized.uploadId
  const url = `/api/uploads/video/${encodeURIComponent(id)}`
  onState?.(initialized)
  let offset = 0
  let state = initialized
  while (offset < file.size) {
    const start = offset
    const end = Math.min(file.size, start + config.chunkBytes)
    state = await retry(() => uploadWithProgress(`${url}/chunk?offset=${start}`, file.slice(start, end), {
      headers: { 'Content-Type': 'application/octet-stream' }, signal, timeout: 120000,
      onProgress: ({ loaded }) => onState?.({ uploadId: id, status: 'receiving', phase: 'uploading', loaded: start + loaded, total: file.size }),
    }), signal).catch(async (error) => {
      if (!retryable(error)) throw error
      const received = await retry(() => api(url, { signal }), signal)
      // 最后分片可能已自动入队；响应丢失时仍只接受本分片完整落盘。
      if (received.received === end) return received
      throw error
    })
    if (state.received !== end) throw new Error('服务器分片进度不一致，请重新上传')
    offset = end
    onState?.(state)
  }
  // 兼容尚未自动入队的服务器；新服务器不需要第二个请求才能开始压缩。
  if (state.status === 'receiving') {
    state = await retry(() => api(`${url}/complete`, { method: 'POST', signal }), signal)
    onState?.(state)
  }
  // 离开页面/网络中断不发送 DELETE；明确移除媒体才取消，未完整接收的任务由服务器过期清理。
  return state.status === 'done' ? state : waitForVideoUpload(id, { signal, onState, onDecision })
}
