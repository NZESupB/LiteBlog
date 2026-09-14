// 数据库初始化与账号种子逻辑,全部持久化数据落在 DATA_DIR
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { configValue, PROJECT_ROOT } from './config.js'

const configuredDataDir = String(configValue('server.dataDir', 'data'))
export const DATA_DIR = path.isAbsolute(configuredDataDir) ? path.resolve(configuredDataDir) : path.resolve(PROJECT_ROOT, configuredDataDir)
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const AVATAR_DIR = path.join(DATA_DIR, 'avatars')
// 视频先流式落到这里再转存最终后端,避免把大文件整体读进内存
export const TMP_DIR = path.join(DATA_DIR, 'tmp')
mkdirSync(UPLOAD_DIR, { recursive: true })
mkdirSync(AVATAR_DIR, { recursive: true })
mkdirSync(TMP_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'blog.db'))

db.exec(`
  PRAGMA journal_mode = WAL;
  -- SQLite 默认不启用外键,不开则 ON DELETE CASCADE 全部失效(孤儿数据只能手动清)
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    avatar_filename TEXT,
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
    sort     INTEGER NOT NULL DEFAULT 0,
    storage  TEXT NOT NULL DEFAULT 'local',
    hash     TEXT NOT NULL DEFAULT '',
    storage_path TEXT NOT NULL DEFAULT '',
    -- 一行 = 一个逻辑媒体项:image / video。实况图的配对视频与视频封面帧都是本行附属文件,
    -- 不单独占行,否则时间轴格子数与相册计数都会翻倍。
    type     TEXT NOT NULL DEFAULT 'image',
    motion_filename TEXT,
    motion_storage  TEXT,
    motion_path     TEXT,
    poster_filename TEXT,
    poster_storage  TEXT,
    poster_path     TEXT,
    duration REAL
  );
  -- 已传到存储后端但还没归属任何动态的图片(选图即上传),发布时转入 images
  CREATE TABLE IF NOT EXISTS pending_uploads (
    filename   TEXT PRIMARY KEY,
    hash       TEXT NOT NULL,
    storage    TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    draft_id   TEXT,
    storage_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_images_post ON images(post_id);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    reply_to   INTEGER,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE TABLE IF NOT EXISTS post_reactions (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_post ON post_reactions(post_id);
  -- 按用户存放个性化配置(目前仅 LLM),与全局 settings 分离
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  -- Web Push 订阅:一个用户可能在多台设备上开启通知,endpoint 天然唯一
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  CREATE TABLE IF NOT EXISTS drafts (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    INTEGER,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id, status);
  CREATE TABLE IF NOT EXISTS image_jobs (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    draft_id     TEXT,
    prompt_hash  TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    filename     TEXT,
    storage      TEXT,
    storage_path TEXT,
    mime         TEXT,
    hash         TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_image_jobs_user ON image_jobs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_image_jobs_draft ON image_jobs(draft_id, status);
`)

// 旧库迁移:早期 users.name 同时承担登录账号和显示名称,先复制为 username
const userColumns = db.prepare('PRAGMA table_info(users)').all()
if (!userColumns.some((col) => col.name === 'username')) {
  db.exec('ALTER TABLE users ADD COLUMN username TEXT')
}
db.exec("UPDATE users SET username = name WHERE username IS NULL OR trim(username) = ''")
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)')

// 头像独立存储,旧账号默认继续使用文字头像
if (!userColumns.some((col) => col.name === 'avatar_filename')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_filename TEXT')
}

// 旧库补列:早期 images 表没有 storage,历史图片一律视为本地存储
if (!db.prepare('PRAGMA table_info(images)').all().some((col) => col.name === 'storage')) {
  db.exec("ALTER TABLE images ADD COLUMN storage TEXT NOT NULL DEFAULT 'local'")
}

// 旧库补列:去重原先靠「文件名 = 内容哈希」,改为日期文件名后改用 hash 列,旧行用文件名前 16 位回填
if (!db.prepare('PRAGMA table_info(images)').all().some((col) => col.name === 'hash')) {
  db.exec("ALTER TABLE images ADD COLUMN hash TEXT NOT NULL DEFAULT ''")
  db.exec("UPDATE images SET hash = substr(filename, 1, 16)")
}
db.exec('CREATE INDEX IF NOT EXISTS idx_images_hash ON images(hash)')
if (!db.prepare('PRAGMA table_info(images)').all().some((col) => col.name === 'storage_path')) {
  db.exec("ALTER TABLE images ADD COLUMN storage_path TEXT NOT NULL DEFAULT ''")
}

// 旧库补列:实况图的配对视频(motion)与视频封面帧(poster)各是一组附属文件,历史图片默认都是普通图片
const imageColumns = db.prepare('PRAGMA table_info(images)').all()
if (!imageColumns.some((col) => col.name === 'type')) {
  db.exec("ALTER TABLE images ADD COLUMN type TEXT NOT NULL DEFAULT 'image'")
}
for (const column of ['motion_filename', 'motion_storage', 'motion_path', 'poster_filename', 'poster_storage', 'poster_path']) {
  if (!imageColumns.some((col) => col.name === column)) db.exec(`ALTER TABLE images ADD COLUMN ${column} TEXT`)
}
if (!imageColumns.some((col) => col.name === 'duration')) {
  db.exec('ALTER TABLE images ADD COLUMN duration REAL')
}

const pendingColumns = db.prepare('PRAGMA table_info(pending_uploads)').all()
if (!pendingColumns.some((col) => col.name === 'draft_id')) {
  db.exec('ALTER TABLE pending_uploads ADD COLUMN draft_id TEXT')
}
if (!pendingColumns.some((col) => col.name === 'storage_path')) {
  db.exec("ALTER TABLE pending_uploads ADD COLUMN storage_path TEXT NOT NULL DEFAULT ''")
}
db.exec("UPDATE images SET storage_path = filename WHERE trim(storage_path) = ''")
db.exec("UPDATE pending_uploads SET storage_path = filename WHERE trim(storage_path) = ''")

// 旧库补列:私密模式下按文章单独控制「公开正文」「公开图片」,默认都不公开
const postColumns = db.prepare('PRAGMA table_info(posts)').all()
if (!postColumns.some((col) => col.name === 'public_text')) {
  db.exec('ALTER TABLE posts ADD COLUMN public_text INTEGER NOT NULL DEFAULT 0')
}
if (!postColumns.some((col) => col.name === 'public_images')) {
  db.exec('ALTER TABLE posts ADD COLUMN public_images INTEGER NOT NULL DEFAULT 0')
}

// 旧库补列:评论回复使用同一动态内的扁平关联,根评论保持 NULL。
const commentColumns = db.prepare('PRAGMA table_info(comments)').all()
if (!commentColumns.some((col) => col.name === 'reply_to')) {
  db.exec('ALTER TABLE comments ADD COLUMN reply_to INTEGER')
}
db.exec('CREATE INDEX IF NOT EXISTS idx_comments_reply_to ON comments(reply_to)')

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

// 首次启动(数据库为空)时写入固定初始账号,登录后请立即修改密码
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
if (userCount === 0) {
  const insert = db.prepare('INSERT INTO users (username, name, pass_hash) VALUES (?, ?, ?)')
  for (const [username, password] of [['user1', 'pass1'], ['user2', 'pass2']]) {
    insert.run(username, username, hashPassword(password))
    console.log(`已创建初始账号: ${username}`)
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

// 按用户读写个性化配置(如 LLM),与全局 settings 同构但归属 user_id
export function getUserSetting(userId, key, fallback = '') {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key)
  return row ? row.value : fallback
}

export function setUserSetting(userId, key, value) {
  db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, value)
}
