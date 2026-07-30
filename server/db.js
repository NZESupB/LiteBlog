// 数据库初始化与账号种子逻辑,全部持久化数据落在 DATA_DIR
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'blog.db'))

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    pass_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS images (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    sort     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_images_post ON images(post_id);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const actual = scryptSync(password, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// 首次启动时按 USERS 环境变量(昵称:密码,逗号分隔)写入初始账号
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
if (userCount === 0) {
  const spec = process.env.USERS || '小A:123456,小B:123456'
  const insert = db.prepare('INSERT INTO users (name, pass_hash) VALUES (?, ?)')
  for (const pair of spec.split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const name = pair.slice(0, idx).trim()
    const password = pair.slice(idx + 1).trim()
    if (!name || !password) continue
    insert.run(name, hashPassword(password))
    console.log(`已创建初始账号: ${name}`)
  }
}

// 站点设置:数据库可后台修改,优先于环境变量(环境变量视为初始值)
export function getSetting(key, envFallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : envFallback
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
