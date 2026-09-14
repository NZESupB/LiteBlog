// 媒体采集工具:判定图片/视频、按文件名主干配对实况图、抽视频封面帧与读时长。
// 只在浏览器里跑(依赖 createImageBitmap / <video> / canvas),服务端不做任何转码。

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])

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
  return String(file.type || '').startsWith('image/') || IMAGE_TYPES.has(String(file.type).toLowerCase())
}

// 把一次选择里的文件按主干分组:同一主干上同时出现静帧与视频时,视频就是这张实况图的动态部分。
// 配不上配对视频的视频一律当普通视频;不做提示、不要求用户手动挂载。
// 返回 [{ still, motion, video }],顺序与用户选择顺序一致,每个文件只会出现在一个结果里。
export function groupMediaFiles(files) {
  const list = [...files]
  const buckets = new Map()
  for (const file of list) {
    const stem = mediaStem(file.name)
    if (!buckets.has(stem)) buckets.set(stem, { stills: [], videos: [] })
    const bucket = buckets.get(stem)
    if (isVideoFile(file)) bucket.videos.push(file)
    else bucket.stills.push(file)
  }
  // 每个主干只认第一对:多出来的静帧/视频当作独立媒体项,避免一张图挂多个动态部分
  const motionByStill = new Map()
  const stillByMotion = new Map()
  for (const bucket of buckets.values()) {
    if (!bucket.stills.length || !bucket.videos.length) continue
    const [still] = bucket.stills
    const [motion] = bucket.videos
    motionByStill.set(still, motion)
    stillByMotion.set(motion, still)
  }
  const items = []
  const emitted = new Set()
  for (const file of list) {
    if (emitted.has(file)) continue
    // 先遇到配对视频时,把整对放在视频的位置上,静帧不再单独出现
    const stillPair = stillByMotion.get(file)
    if (stillPair) {
      if (emitted.has(stillPair)) continue
      emitted.add(stillPair)
      emitted.add(file)
      items.push({ still: stillPair, motion: file, video: null })
      continue
    }
    emitted.add(file)
    const motion = motionByStill.get(file)
    if (motion) {
      emitted.add(motion)
      items.push({ still: file, motion, video: null })
      continue
    }
    items.push(isVideoFile(file)
      ? { still: null, motion: null, video: file }
      : { still: file, motion: null, video: null })
  }
  return items
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

// 秒钟 → 封面角标用的 m:ss
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', done); resolve() }
    video.addEventListener('seeked', done)
    video.addEventListener('error', done)
    try { video.currentTime = time } catch { done() }
  })
}

function loadMetadata(video, url) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('无法读取视频信息,请确认格式为 MP4 / MOV / WebM'))
    video.addEventListener('loadedmetadata', () => resolve(), { once: true })
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
