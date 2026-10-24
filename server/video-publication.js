// 发布引用决定后台视频任务是否仍有所有者；与草稿状态分别校验。
import { db } from './db.js'

export function videoReferenced(job) {
  const names = new Set([job.filename, ...Object.values(job.variants || {}).map((variant) => variant.filename)])
  return [...names].some((name) => name && db.prepare(
    'SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1',
  ).get(name, name, name))
}

export function originalReady(job) {
  const original = job.variants?.original
  // 旧快照没有就绪标记，仅在保存、探测和封面信息齐全时兼容恢复。
  return Boolean(job.originalReady !== false && original?.filename && original.available !== false
    && original.hash && original.codec && original.size > 0 && original.duration > 0
    && job.received > 0 && job.total === job.received && (!job.needsPoster || job.poster))
}

// 只替换仍引用本任务原件的记录，删除/编辑后的记录不会被重新创建。
// 调用方将引用和任务快照放在同一个事务中提交。
export function promotePublishedVideo(job) {
  const original = job.variants?.original
  const selected = job.variants?.[job.selectedVariant]
  if (!original || !selected || selected.available === false || selected.filename === original.filename) return
  if (job.selectionSource === 'user' && job.selectedVariant === 'original') return
  const owner = 'post_id IN (SELECT id FROM posts WHERE user_id = ?)'
  const primary = db.prepare(`UPDATE images SET filename = ?, storage = ?, storage_path = ?, hash = ?, duration = ? WHERE filename = ? AND ${owner}`)
    .run(selected.filename, selected.backend, selected.storagePath, selected.hash, selected.duration || job.duration || null, original.filename, job.userId)
  const motion = db.prepare(`UPDATE images SET motion_filename = ?, motion_storage = ?, motion_path = ? WHERE motion_filename = ? AND ${owner}`)
    .run(selected.filename, selected.backend, selected.storagePath, original.filename, job.userId)
  if (primary.changes || motion.changes) db.prepare('DELETE FROM pending_uploads WHERE filename = ? AND user_id = ?')
    .run(selected.filename, job.userId)
}
