// 任务产物只有完整校验、同步落盘后才登记；执行代次隔离意外遗留子进程。
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { db } from './db.js'

export const signature = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function hashFile(file, options = {}) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, options)) hash.update(chunk)
  return hash.digest('hex')
}
export async function syncFile(file) {
  const handle = await open(file, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
export async function artifact(job, name, fingerprint, build, verify) {
  if (!/^[a-z0-9-]+\.(mp4|m4a|jpg|json)$/.test(name)) throw new Error('检查点名称无效')
  await mkdir(job.directory, { recursive: true })
  const target = path.join(job.directory, name)
  const row = db.prepare('SELECT snapshot FROM video_artifacts WHERE job_id = ? AND name = ?').get(job.id, name)
  if (row) {
    const saved = JSON.parse(row.snapshot)
    if (saved.fingerprint !== fingerprint && name.startsWith('video-')) throw Object.assign(new Error('检查点参数与任务快照不一致，需恢复原编码器或取消任务'), { retryable: true })
    try {
      if (saved.fingerprint === fingerprint && (await stat(target)).size === saved.size && await hashFile(target, { signal: job.controller.signal }) === saved.hash) return { ...saved, path: target, reused: true }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    db.prepare('DELETE FROM video_artifacts WHERE job_id = ? AND name = ?').run(job.id, name)
  }
  const temporary = path.join(job.directory, `${job.generation}-${name}.part${path.extname(name)}`)
  try {
    await build(temporary)
    job.controller.signal.throwIfAborted()
    const metadata = await verify(temporary)
    const size = (await stat(temporary)).size
    if (!size) throw new Error('检查点产物为空')
    const hash = await hashFile(temporary, { signal: job.controller.signal })
    await syncFile(temporary)
    await rename(temporary, target)
    await syncFile(job.directory)
    const snapshot = { fingerprint, size, hash, metadata, completedAt: Date.now() }
    db.prepare('INSERT INTO video_artifacts (job_id, name, snapshot) VALUES (?, ?, ?) ON CONFLICT(job_id, name) DO UPDATE SET snapshot = excluded.snapshot')
      .run(job.id, name, JSON.stringify(snapshot))
    return { ...snapshot, path: target, reused: false }
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error }) }
}
export function nextGeneration(job) { job.generation = randomUUID() }
