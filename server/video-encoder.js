// FFmpeg 在独立子进程执行；软件和硬件编码参数分开，输出及错误有界。
import { spawn } from 'node:child_process'
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { configValue } from './config.js'

export const FFMPEG = String(configValue('media.ffmpegPath', 'ffmpeg'))
export const FFPROBE = String(configValue('media.ffprobePath', 'ffprobe'))
export const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm']
export const baseOptions = ['-hide_banner', '-v', 'error', '-nostdin', '-y']

export function command(program, args, { signal, timeout = 30000, idleTimeout = 0, onOutput, onChild } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    onChild?.(child)
    let output = '', errorOutput = '', reason = null, forceTimer, idleTimer, lastTime = -1, pending = ''
    const stop = (error) => {
      reason ||= error
      child.kill('SIGTERM')
      forceTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000)
      forceTimer.unref()
    }
    const abort = () => stop(signal.reason || new DOMException('视频处理已停止', 'AbortError'))
    const resetIdle = () => {
      clearTimeout(idleTimer)
      if (idleTimeout) {
        idleTimer = setTimeout(() => stop(Object.assign(new Error('编码长时间无有效进度，可从检查点重试'), { retryable: true })), idleTimeout)
        idleTimer.unref()
      }
    }
    const timer = timeout ? setTimeout(() => stop(Object.assign(new Error('处理阶段超时，可从检查点重试'), { retryable: true })), timeout) : null
    timer?.unref()
    resetIdle()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      if (onOutput) {
        const text = chunk.toString()
        pending += text
        const lines = pending.split('\n')
        pending = lines.pop() || ''
        for (const line of lines) if (line.startsWith('out_time_us=')) {
          const time = Number(line.slice(12))
          if (time > lastTime) { lastTime = time; resetIdle() }
        }
        try { onOutput(text) } catch (error) { stop(error) }
      } else if (output.length + chunk.length > 2 * 1024 ** 2) stop(new Error('视频信息输出超过限制'))
      else output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk.toString()).slice(-4000) })
    child.on('error', (error) => { reason = error })
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(idleTimer)
      signal?.removeEventListener('abort', abort)
      if (reason) reject(reason)
      else if (code !== 0) reject(Object.assign(new Error(`视频处理失败：${errorOutput.trim().slice(-800) || exitSignal || `退出码 ${code}`}`), { retryable: Boolean(exitSignal) }))
      else resolve(output)
    })
  })
}

async function optionalFile(filename) {
  try { return (await readFile(filename, 'utf8')).trim() }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return ''; throw error }
}
export async function resourceLimits() {
  let cpus = os.availableParallelism()
  let memory = Math.min(os.totalmem(), process.constrainedMemory?.() || Infinity)
  if (process.platform === 'linux') {
    const [cpu, quota, period, mem2, mem1] = await Promise.all([
      optionalFile('/sys/fs/cgroup/cpu.max'), optionalFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
      optionalFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us'), optionalFile('/sys/fs/cgroup/memory.max'),
      optionalFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    ])
    const [q, p] = cpu.split(/\s+/).map(Number)
    if (q > 0 && p > 0) cpus = Math.min(cpus, Math.max(1, Math.floor(q / p)))
    else if (Number(quota) > 0 && Number(period) > 0) cpus = Math.min(cpus, Math.max(1, Math.floor(Number(quota) / Number(period))))
    for (const value of [mem2, mem1]) if (Number(value) > 0) memory = Math.min(memory, Number(value))
  }
  const configured = Number(configValue('media.videoThreads', 16))
  if (!Number.isInteger(configured) || configured < 1 || configured > 16) throw new Error('videoThreads 必须为 1–16 的整数')
  return { threads: Math.max(1, Math.min(configured, cpus, Math.floor(memory / (512 * 1024 ** 2)))), cpus, memory }
}
export function encoderArgs(profile, encoder) {
  if (encoder.name === 'hevc_videotoolbox') return ['-c:v', encoder.name, '-profile:v', 'main10', '-pix_fmt', 'p010le', '-allow_sw', '0',
    '-b:v', String(profile.videoRate), '-maxrate', String(profile.videoRate), '-bufsize', String(profile.videoRate * 2)]
  if (encoder.name !== 'libx265') throw new Error('任务的编码器不受支持')
  return ['-c:v', 'libx265', '-profile:v', 'main10', '-pix_fmt', 'yuv420p10le', '-preset', profile.preset, '-crf', String(profile.crf),
    '-threads', String(encoder.threads), '-x265-params', `pools=${encoder.threads}:vbv-maxrate=${profile.videoRate / 1000}:vbv-bufsize=${profile.videoRate * 2 / 1000}:log-level=error`]
}
export async function detectVideoTools() {
  const resources = await resourceLimits()
  const [encoders, filters] = await Promise.all([
    command(FFMPEG, ['-hide_banner', '-encoders']), command(FFMPEG, ['-hide_banner', '-filters']), command(FFPROBE, ['-version']),
  ])
  for (const encoder of ['libx265', 'aac', 'mjpeg']) if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`FFmpeg 缺少 ${encoder} 编码器`)
  for (const filter of ['scale', 'fps', 'zscale', 'tonemap']) if (!new RegExp(`\\b${filter}\\b`).test(filters)) throw new Error(`FFmpeg 缺少 ${filter} 滤镜`)
  const requested = String(configValue('media.videoEncoder', 'auto'))
  if (!['auto', 'libx265', 'hevc_videotoolbox'].includes(requested)) throw new Error('videoEncoder 只支持 auto / libx265 / hevc_videotoolbox')
  let hardwareError = ''
  const supported = ['libx265']
  if (requested !== 'libx265' && process.platform === 'darwin' && /\bhevc_videotoolbox\b/.test(encoders)) {
    try {
      for (const size of ['1920x1080', '3840x2160']) await command(FFMPEG, [...baseOptions, '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=60`, '-frames:v', '4',
        '-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-allow_sw', '0', '-b:v', '16000k', '-an', '-f', 'null', '-'], { timeout: 30000 })
      supported.push('hevc_videotoolbox')
    } catch (error) { hardwareError = error.message }
  } else if (requested !== 'libx265') hardwareError = '当前系统/FFmpeg 没有可用的 VideoToolbox 硬件编码'
  if (requested === 'hevc_videotoolbox' && !supported.includes(requested)) throw new Error(hardwareError)
  const name = requested === 'libx265' ? requested : supported.includes('hevc_videotoolbox') ? 'hevc_videotoolbox' : 'libx265'
  return { available: true, error: '', encoder: { name, threads: resources.threads }, supported,
    reason: name === 'libx265' && requested === 'auto' ? hardwareError : '', resources }
}
