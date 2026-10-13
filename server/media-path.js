// 媒体文件名与日期路径统一使用上海时区；调用方固定时间后贯穿保存与清理。
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

export function uploadTime(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : Date.now()
}

export function mediaDateParts(time) {
  return Object.fromEntries(dateFormat.formatToParts(new Date(uploadTime(time))).map((part) => [part.type, part.value]))
}

export function datedMediaPath(filename, time) {
  const p = mediaDateParts(time)
  return `${p.year.padStart(4, '0')}/${p.month}/${filename}`
}

export function conflictMediaPath(relativePath) {
  const ext = path.posix.extname(relativePath)
  return `${relativePath.slice(0, relativePath.length - ext.length)}-${randomBytes(8).toString('hex')}${ext}`
}
