import { db } from '../db.js'

// 每次读取当前连接，整库恢复后不能持有旧连接或旧 prepared statement。
export function isReferenced(filename) {
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM images WHERE filename = ? OR motion_filename = ? OR poster_filename = ? LIMIT 1',
      )
      .get(filename, filename, filename) ||
    db.prepare('SELECT 1 FROM pending_uploads WHERE filename = ? LIMIT 1').get(filename),
  )
}
export function mediaFiles(row) {
  const files = [{ filename: row.filename, storage: row.storage, path: row.storage_path || row.filename }]
  if (row.motion_filename)
    files.push({
      filename: row.motion_filename,
      storage: row.motion_storage || row.storage,
      path: row.motion_path || row.motion_filename,
    })
  if (row.poster_filename)
    files.push({
      filename: row.poster_filename,
      storage: row.poster_storage || row.storage,
      path: row.poster_path || row.poster_filename,
    })
  return files
}
