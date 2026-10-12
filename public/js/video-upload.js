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
export const getVideoUploadConfig = (signal) => api('/api/uploads/video/config', { signal })
export async function cancelVideoUpload(id) {
  try { return await api(`/api/uploads/video/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
  catch (error) { if (error.status !== 404) throw error }
}
export async function waitForVideoUpload(id, { signal, onState } = {}) {
  const url = `/api/uploads/video/${encodeURIComponent(id)}`
  const deadline = Date.now() + 6 * 60 * 60 * 1000
  while (Date.now() < deadline) {
    const state = await retry(() => api(url, { signal }), signal)
    onState?.(state)
    if (state.status === 'done' && state.filename) return state
    if (state.status === 'failed') throw new Error(state.error || '视频压缩或保存失败')
    if (state.status === 'cancelled') throw new Error('视频任务已取消，请重新选择视频')
    if (state.status === 'receiving') {
      if (state.total > 0 && state.received === state.total) await retry(() => api(`${url}/complete`, { method: 'POST', signal }), signal)
      else throw new Error('原视频尚未完整上传，请移除这项并重新选择视频')
    }
    await wait(1000, signal)
  }
  throw new Error('视频仍在后台处理，请稍后重新打开草稿查看')
}
export async function uploadVideo(file, { draftId, needsPoster = true, signal, onState } = {}) {
  const config = await getVideoUploadConfig(signal)
  if (!config.available) throw new Error(config.error || '视频处理工具不可用')
  if (file.size > config.maxBytes) throw new Error(`原视频不能超过 ${Math.round(config.maxBytes / 1024 / 1024)}MiB`)
  const initialized = await api('/api/uploads/video/init', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, contentType: videoContentType(file), size: file.size, needsPoster }),
  })
  const id = initialized.uploadId
  const url = `/api/uploads/video/${encodeURIComponent(id)}`
  onState?.(initialized)
  let submitted = false
  try {
    let offset = 0
    while (offset < file.size) {
      const start = offset
      const end = Math.min(file.size, start + config.chunkBytes)
      const result = await retry(() => uploadWithProgress(`${url}/chunk?offset=${start}`, file.slice(start, end), {
        headers: { 'Content-Type': 'application/octet-stream' }, signal, timeout: 120000,
        onProgress: ({ loaded }) => onState?.({ uploadId: id, status: 'receiving', phase: 'uploading', loaded: start + loaded, total: file.size }),
      }), signal).catch(async (error) => {
        if (!retryable(error)) throw error
        const state = await retry(() => api(url, { signal }), signal)
        // 只接受本分片完整落盘，不能把局部进度当作成功而跳过字节。
        if (state.status === 'receiving' && state.received === end) return state
        throw error
      })
      if (result.received !== end) throw new Error('服务器分片进度不一致，请重新上传')
      offset = end
      onState?.(result)
    }
    // complete 可重复调用；即使响应丢失，保留已接收任务供草稿恢复。
    submitted = true
    const state = await retry(() => api(`${url}/complete`, { method: 'POST', signal }), signal)
    onState?.(state)
    return await waitForVideoUpload(id, { signal, onState })
  } catch (error) {
    // 关闭编辑器只停止已提交任务的轮询；移除媒体由调用方显式取消。
    if (!submitted) await cancelVideoUpload(id).catch((e) => console.warn(`取消未完成视频上传失败：${e.message}`))
    throw error
  }
}
