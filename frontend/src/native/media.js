// 媒体类型判定与视频封面工具；实况照片归一化统一走 live-photo.js。
// 浏览器抽帧仅用于即时预览；正式视频与封面由服务端处理。

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif'])

function extension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return match ? match[1].toLowerCase() : ''
}

// 文件名主干(去扩展名,大写)。实况图的静帧与配对视频来自同一次导出,主干一致:
// IMG_1234.HEIC + IMG_1234.MOV(iPhone)、IMG_1234.jpg + IMG_1234.mp4(Google Takeout)。
export function mediaStem(name) {
  return String(name || '').replace(/\.[^.]+$/, '').toUpperCase()
}

export function isVideoFile(file) {
  if (!file) return false
  if (VIDEO_TYPES.has(String(file.type).toLowerCase())) return true
  if (String(file.type || '').startsWith('video/')) return true
  return VIDEO_EXTENSIONS.has(extension(file.name)) && !IMAGE_TYPES.has(String(file.type).toLowerCase())
}

export function isImageFile(file) {
  if (!file) return false
  if (isVideoFile(file)) return false
  return String(file.type || '').startsWith('image/') || IMAGE_EXTENSIONS.has(extension(file.name))
}


// 上传要带准确的 Content-Type:部分浏览器给 .mov 的 type 是空的
export function videoContentType(file) {
  const type = String(file?.type || '').toLowerCase()
  if (VIDEO_TYPES.has(type)) return type
  const ext = extension(file?.name)
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  return 'video/mp4'
}

// 小文件先读取字节，脱离照片提供器的临时文件；大文件只预检，不全量复制到内存。
export async function materializePickedFile(file, { signal } = {}) {
  signal?.throwIfAborted()
  try {
    if (!file.size) throw new Error('收到空文件，原件可能尚未下载完成')
    if (file.size <= 32 * 1024 * 1024) {
      const bytes = await file.arrayBuffer()
      signal?.throwIfAborted()
      if (bytes.byteLength !== file.size) throw new Error('原件读取不完整')
      return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified })
    }
    const count = 64 * 1024
    for (const offset of [0, file.size - count]) {
      const bytes = await file.slice(offset, offset + count).arrayBuffer()
      signal?.throwIfAborted()
      if (bytes.byteLength !== count) throw new Error('原件读取不完整')
    }
    return file
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`原件读取失败：${error.message || error}。请先下载或导出原件，再从“文件”重新选择。`, { cause: error })
  }
}

// 秒钟 → 封面角标用的 m:ss
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 5000)
    function done() { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', done); resolve() }
    video.addEventListener('seeked', done)
    video.addEventListener('error', done)
    try { video.currentTime = time } catch { done() }
  })
}

function loadMetadata(video, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', loaded); video.removeEventListener('error', fail) }
    const loaded = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(new Error('浏览器无法读取原视频，将由服务器生成封面')) }
    const timer = setTimeout(fail, 10000)
    video.addEventListener('loadedmetadata', loaded, { once: true })
    video.addEventListener('error', fail, { once: true })
    video.src = url
    video.load?.()
  })
}

// 抽一帧做封面:封面必须是图片,列表才不用为了显示格子去加载整个视频。
// 抽 0.1s 附近并避开 0s(不少编码在 0s 是黑场),时长过短时退回第 0 帧。
export async function readVideoPoster(file, maxEdge = 1280) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  try {
    await loadMetadata(video, url)
    const duration = Number.isFinite(video.duration) ? video.duration : null
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) throw new Error('视频没有可用的画面轨道')
    await seekTo(video, duration && duration > 0.4 ? Math.min(0.1, duration / 10) : 0)
    const scale = Math.min(1, maxEdge / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
    const poster = blob
      ? new File([blob], `${mediaStem(file.name) || 'video'}.poster.jpg`, { type: 'image/jpeg' })
      : null
    return { duration, poster }
  } finally {
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
  }
}
