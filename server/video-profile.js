// 固定视频策略：依据真实像素量、帧率与音轨选择预算，MB 为十进制。
export const VIDEO_POLICY_VERSION = 1
export const MAX_FRAME_RATE = 60
export const AUDIO_RATE = 128000
export const VIDEO_PROFILES = Object.freeze([
  { width: 1920, height: 1080, fps: 30, mbPerMinute: 25, crf: 21 },
  { width: 1920, height: 1080, fps: 60, mbPerMinute: 35, crf: 21 },
  { width: 3840, height: 2160, fps: 30, mbPerMinute: 85, crf: 22 },
  { width: 3840, height: 2160, fps: 60, mbPerMinute: 120, crf: 22 },
])
export function videoProfile(info) {
  const pixels = info.width * info.height, base = 1920 * 1080
  const frameWeight = Math.max(0, Math.min(1, (info.rate - 30) / 30))
  const low = 25 + 10 * frameWeight, high = 85 + 35 * frameWeight
  const mb = pixels <= base ? low * pixels / base : pixels <= base * 4 ? low + (high - low) * (pixels - base) / (base * 3) : high * pixels / (base * 4)
  const audioRate = info.audio.length ? AUDIO_RATE : 0
  const videoRate = Math.max(100000, Math.floor((mb * 1e6 * 8 / 60 * .95 - audioRate) / 1000) * 1000)
  const bytesPerMinute = Math.max(mb * 1e6, (videoRate + audioRate) * 60 / 8 / .95)
  return { version: VIDEO_POLICY_VERSION, bytesPerMinute, mbPerMinute: bytesPerMinute / 1e6, budgetBytes: Math.ceil(info.duration / 60 * bytesPerMinute),
    videoRate, audioRate, crf: pixels <= base ? 21 : 22, preset: 'fast', maxFps: MAX_FRAME_RATE, resolution: 'original' }
}
