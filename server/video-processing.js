// 视频处理阶段：基于真实帧边界的可恢复片段，音频独立一次编码。
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifact, signature } from './video-checkpoints.js'
import { FFMPEG, FFPROBE, command, baseOptions, inputOptions, encoderArgs } from './video-encoder.js'
import { MAX_FRAME_RATE } from './video-profile.js'

export function ratio(value) {
  const [a, b = 1] = String(value || '').split('/').map(Number)
  return b ? a / b : 0
}
export async function probe(file, signal, count = false) {
  const raw = await command(FFPROBE, ['-v', 'error', ...inputOptions, ...(count ? ['-count_frames'] : []), '-show_format', '-show_streams', '-of', 'json', file], { signal, timeout: count ? 0 : 30000 })
  const info = JSON.parse(raw)
  const video = info.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (!video?.width || !video?.height) throw new Error('视频没有有效画面轨道')
  const duration = Number(info.format?.duration || video.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效视频时长')
  const rotation = Number(video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation || video.tags?.rotate || 0)
  const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1
  const rate = ratio(video.avg_frame_rate) || ratio(video.r_frame_rate)
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('无法读取有效视频帧率')
  return { ...info, video, duration, rotation, width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    rate, audio: info.streams.filter((s) => s.codec_type === 'audio') }
}
// 对外指标：体积、编码器、尺寸、帧率、色彩/位深与音轨；只读元数据，不做兼容性判断。
export function metrics(info, size) {
  const video = info.video, audio = info.audio?.[0]
  const depth = /p(\d{2})(?:le|be)?$/.exec(video.pix_fmt || '')
  return { size, codec: video.codec_name || '', codecLong: video.codec_long_name || '', profile: video.profile || '',
    codecTag: video.codec_tag_string || '', sampleAspectRatio: video.sample_aspect_ratio || '1:1', fps: info.rate, colorTransfer: video.color_transfer || '',
    pixFmt: video.pix_fmt || '', bitDepth: depth ? Number(depth[1]) : 8,
    width: info.width, height: info.height, rate: info.rate, rotation: info.rotation, duration: info.duration,
    container: String(info.format?.format_name || ''), hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer),
    color: { primaries: video.color_primaries || '', transfer: video.color_transfer || '', space: video.color_space || '', range: video.color_range || '' },
    audio: audio ? { codec: audio.codec_name || '', channels: Number(audio.channels) || 0, sampleRate: Number(audio.sample_rate) || 0, bitRate: Number(audio.bit_rate) || 0 } : null }
}
export function hdrType(info) {
  if (info.video.side_data_list?.some((side) => /DOVI|Dolby/i.test(side.side_data_type || ''))) throw new Error('无法正确处理此 Dolby Vision 色彩格式')
  const transfer = info.video.color_transfer
  if (['smpte2084', 'arib-std-b67'].includes(transfer)) {
    if (info.video.color_primaries !== 'bt2020' || !['bt2020nc', 'bt2020c'].includes(info.video.color_space)) throw new Error('HDR 色彩信息不完整，无法正确转换')
    return true
  }
  if (transfer && !['unknown', 'bt709', 'smpte170m', 'bt470m', 'bt470bg', 'iec61966-2-1', 'smpte240m'].includes(transfer)) throw new Error(`暂不支持此视频色彩传递格式：${transfer}`)
  return false
}
export const outputSize = (info) => ({ width: Math.ceil(info.width / 2) * 2, height: Math.ceil(info.height / 2) * 2 })
export function compatible(info, size, target) {
  return info.video.codec_name === 'hevc' && ['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(info.video.pix_fmt)
    && !hdrType(info) && info.rotation === 0 && info.rate <= MAX_FRAME_RATE && info.width % 2 === 0 && info.height % 2 === 0 && size <= target
    && info.audio.length <= 1 && info.audio.every((s) => s.codec_name === 'aac' && Number(s.channels) <= 2 && Number(s.bit_rate || 0) <= 132000)
}
// 免转码直用源文件的附加条件：MP4 系容器、hvc1、只含选定视频/音轨；faststart 由调用方读取文件确认。
export function directContainer(info) {
  return /^(?:iso[0-9a-z]|mp4[12]|M4V |avc1|MSNV)/.test(info.format.tags?.major_brand || '') && info.video.codec_tag_string === 'hvc1'
    && info.streams.every((stream) => stream.index === info.video.index || stream.index === info.audio[0]?.index)
}
export function videoFilter(info, pixelFormat = 'yuv420p10le') {
  const filters = ['setpts=PTS-STARTPTS']
  if (hdrType(info)) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv')
  const size = outputSize(info)
  filters.push(`pad=${size.width}:${size.height}`)
  if (info.rate > MAX_FRAME_RATE) filters.push(`fps=${MAX_FRAME_RATE}`)
  filters.push(`format=${pixelFormat}`)
  return filters.join(',')
}
async function framePlan(file, info, signal) {
  const segments = []
  let buffer = '', previous = -Infinity, videoStart = null, finalDuration = 1 / info.rate
  const consume = (line) => {
    const fields = Object.fromEntries(line.split('|').map((field) => field.split('=')))
    if (!fields.best_effort_timestamp_time) return
    const time = Number(fields.best_effort_timestamp_time)
    if (!Number.isFinite(time) || time <= previous) throw new Error('视频帧时间戳缺失或不连续，无法建立可靠检查点')
    videoStart ??= time
    const current = segments.at(-1)
    if (!current || time - current.start >= 60 - .000001) {
      if (current) { current.duration = time - current.start; current.lastDuration = time - previous }
      segments.push({ start: time, frames: 0 })
    }
    segments.at(-1).frames++
    previous = time
    finalDuration = Number(fields.duration_time) || 1 / info.rate
  }
  await command(FFPROBE, ['-v', 'error', ...inputOptions, '-select_streams', String(info.video.index), '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,duration_time', '-of', 'compact=p=0', file], {
    signal, timeout: 0, onOutput(chunk) {
      buffer += chunk
      const lines = buffer.split('\n'); buffer = lines.pop() || ''
      for (const line of lines) consume(line)
    },
  })
  if (buffer) consume(buffer)
  if (!segments.length) throw new Error('视频没有可解码帧')
  segments.at(-1).duration = previous + finalDuration - segments.at(-1).start
  segments.at(-1).lastDuration = finalDuration
  const sourceStart = Number(info.format.start_time) || 0
  return { videoStart, duration: previous + finalDuration - videoStart,
    segments: segments.map((segment, index) => ({ ...segment, index, seek: Math.max(0, segment.start - sourceStart), offset: segment.start - videoStart })) }
}

export async function validateVideo(file, source, signal, expectedFrames = null, duration = source.duration) {
  const info = await probe(file, signal, true)
  const expected = outputSize(source)
  if (info.video.codec_name !== 'hevc' || info.video.codec_tag_string !== 'hvc1' || info.width !== expected.width || info.height !== expected.height
    || info.rotation !== 0 || !['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(info.video.pix_fmt)
    || info.rate > MAX_FRAME_RATE + .1 || Math.abs(info.duration - duration) > Math.max(.15, 2 / Math.min(source.rate, MAX_FRAME_RATE))
    || (expectedFrames !== null && Number(info.video.nb_read_frames) !== expectedFrames)
    || (hdrType(source) && info.video.color_transfer !== 'bt709')) throw new Error(`检查点输出验证失败：${JSON.stringify({ codec: info.video.codec_name, tag: info.video.codec_tag_string, size: [info.width, info.height], pixelFormat: info.video.pix_fmt, rate: info.rate, duration: info.duration, frames: info.video.nb_read_frames, expectedFrames, expectedDuration: duration })}`)
  await command(FFMPEG, [...baseOptions, ...inputOptions, '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { signal })
  return info
}

// 片段/合并产物只用于最终保存或重封装；remux 与直通共用同一校验路径。
export async function remuxVideo(job, info, run) {
  const signal = job.controller.signal
  return artifact(job, 'remux.mp4', signature({ source: job.sourceHash, mode: 'remux' }),
    (file) => run([...baseOptions, ...inputOptions, '-i', job.source, '-map', `0:${info.video.index}`, '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '-1',
      '-map_chapters', '-1', '-tag:v', 'hvc1', '-movflags', '+faststart', '-progress', 'pipe:1', file]), (file) => validateVideo(file, info, signal))
}

export async function encodeVideo(job, info, phase, run) {
  const signal = job.controller.signal
  const fingerprint = signature({ source: job.sourceHash, profile: job.profile, encoder: job.encoder, info: info.video })
  phase('planning')
  const planArtifact = await artifact(job, 'frames.json', signature({ source: job.sourceHash, stream: info.video.index }),
    async (file) => writeFile(file, JSON.stringify(await framePlan(job.source, info, signal))), async (file) => JSON.parse(await readFile(file, 'utf8')))
  const plan = planArtifact.metadata
  const segments = []
  job.segmentCount = plan.segments.length
  job.completedSegments = 0
  job.completedSeconds = 0
  for (const segment of plan.segments) {
    phase('compressing')
    job.currentSegment = segment.index + 1
    const result = await artifact(job, `video-${segment.index}.mp4`, signature({ fingerprint, segment }), async (file) => {
      if (!(await job.capability()).supported?.includes(job.encoder.name)) throw Object.assign(new Error(`恢复需要原编码器 ${job.encoder.name}，请修复环境后重试`), { retryable: true })
      const format = job.encoder.name === 'hevc_videotoolbox' ? 'p010le' : 'yuv420p10le'
      await run([...baseOptions, ...inputOptions, '-threads', String(job.encoder.threads), '-ss', String(Math.max(0, segment.seek - .000001)), '-i', job.source,
        '-map', `0:${info.video.index}`, '-an', '-map_metadata', '-1', '-map_chapters', '-1', '-vf', videoFilter(info, format),
        ...encoderArgs(job.profile, job.encoder), '-filter_threads', String(job.encoder.threads),
        '-t', String(segment.duration), ...(info.rate <= MAX_FRAME_RATE ? ['-frames:v', String(segment.frames)] : []),
        '-fps_mode', 'passthrough', '-video_track_timescale', '90000',
        '-bsf:v', `setts=pts=PTS:dts=DTS:duration=if(lte(DURATION\\,1)\\,${info.rate > MAX_FRAME_RATE ? 1 / MAX_FRAME_RATE : segment.lastDuration}/TB\\,DURATION)`,
        ...(hdrType(info) ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
        '-tag:v', 'hvc1', '-movflags', '+faststart', '-progress', 'pipe:1', file], segment)
    }, (file) => validateVideo(file, info, signal, info.rate <= MAX_FRAME_RATE ? segment.frames : null, segment.duration))
    segments.push({ ...result, duration: segment.duration })
    job.completedSegments++
    job.completedSeconds += segment.duration
    job.processedSeconds = job.completedSeconds
    phase('compressing')
  }
  let audio = null
  if (info.audio.length) {
    phase('audio')
    audio = await artifact(job, 'audio.m4a', signature({ source: job.sourceHash, audio: info.audio[0] }),
      (file) => run([...baseOptions, ...inputOptions, '-threads', String(job.encoder.threads), '-i', job.source, '-map', '0:a:0', '-vn', '-af', 'asetpts=PTS-STARTPTS',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-map_metadata', '-1', file]), async (file) => {
        const raw = JSON.parse(await command(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal }))
        const stream = raw.streams.find((s) => s.codec_type === 'audio')
        if (!stream || stream.codec_name !== 'aac' || stream.channels > 2 || Math.abs(Number(raw.format.duration) - Number(info.audio[0].duration || info.duration)) > .2) throw new Error('音频检查点验证失败')
        return raw
      })
  }
  phase('merging')
  const output = await artifact(job, 'output.mp4', signature({ fingerprint, segments: segments.map((s) => s.hash), audio: audio?.hash }), async (file) => {
    const list = path.join(job.directory, `${job.generation}-concat.txt`)
    await writeFile(list, 'ffconcat version 1.0\n' + segments.map((s) => `file '${path.basename(s.path)}'\nduration ${s.duration.toFixed(9)}\n`).join(''))
    const audioOffset = Number(info.audio[0]?.start_time || 0) - plan.videoStart
    await run([...baseOptions, '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', list,
      ...(audio ? ['-itsoffset', String(audioOffset), '-i', audio.path] : []), '-map', '0:v:0', ...(audio ? ['-map', '1:a:0'] : []),
      '-c', 'copy', '-tag:v', 'hvc1', '-video_track_timescale', '90000', '-movflags', '+faststart', '-map_metadata', '-1', file])
  }, async (file) => {
    const audioEnd = info.audio.length ? (Number(info.audio[0].start_time || 0) - plan.videoStart + Number(info.audio[0].duration || info.duration)) : 0
    const final = await validateVideo(file, info, signal, info.rate <= MAX_FRAME_RATE ? plan.segments.reduce((sum, s) => sum + s.frames, 0) : null, Math.max(plan.duration, audioEnd))
    if (final.audio.length !== (info.audio.length ? 1 : 0) || final.audio.some((s) => s.codec_name !== 'aac' || s.channels > 2)) throw new Error('最终音轨验证失败')
    if (info.audio.length && Math.abs((Number(final.audio[0].start_time || 0) - Number(final.video.start_time || 0)) - (Number(info.audio[0].start_time || 0) - plan.videoStart)) > .08) throw new Error('输出音视频同步验证失败')
    return final
  })
  return output
}
