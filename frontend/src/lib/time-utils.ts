/**
 * 规范化时间为 24 小时制 HH:mm 格式
 */
export function normalizeTime(raw: string | undefined | null, fallback = '03:30'): string {
  if (!raw) return fallback
  const trimmed = raw.trim()
  const match = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (!match) return fallback
  const hour = match[1].padStart(2, '0')
  const minute = match[2].padStart(2, '0')
  return `${hour}:${minute}`
}
