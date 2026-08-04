#!/usr/bin/env node
// 数据导出脚本:把 SQLite(blog.db)导出为 MySQL 可导入的 SQL 与及 JSON 快照。
// 用途:未来若需迁往 MySQL 等数据库,先 `node tools/export-mysql.mjs` 再导入目标库。
// 本脚本只读不写,不修改 data/ 下任何数据。需 Node >= 22(node:sqlite)。
//
// 用法:
//   node tools/export-mysql.mjs            # 默认读 ./data/blog.db,输出到 ./export/
//   DATA_DIR=/path node tools/export-mysql.mjs
//   OUT_DIR=./out node tools/export-mysql.mjs

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data')
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'export')
const DB_PATH = path.join(DATA_DIR, 'blog.db')

if (!fs.existsSync(DB_PATH)) {
  console.error(`找不到数据库: ${DB_PATH}`)
  process.exit(1)
}
fs.mkdirSync(OUT_DIR, { recursive: true })

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const bool = new Set(['private_mode'])

const TABLES = ['users', 'posts', 'images', 'comments', 'settings']

const sqlLines = ['-- 导出自 couple-blog (SQLite),目标 MySQL', 'SET NAMES utf8mb4;', 'SET FOREIGN_KEY_CHECKS=0;', '']

for (const table of TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.length === 0) { sqlLines.push(`-- 表 ${table} 不存在,跳过`); continue }
  const colNames = cols.map((c) => c.name)
  const rows = db.prepare(`SELECT * FROM ${table}`).all()
  sqlLines.push(`DROP TABLE IF EXISTS ${table};`)
  sqlLines.push(`-- ${rows.length} 行`)
  // 建表:映射到 MySQL 简易类型
  const defs = colNames.map((name) => {
    if (name.includes('id') || name.endsWith('_id')) return `${name} BIGINT`
    return `${name} MEDIUMTEXT`
  })
  const pkJoin = (cols.find((c) => c.pk) || {}).name
  const pks = cols.filter((c) => c.pk).map((c) => `\`${c.name}\``)
  sqlLines.push(`CREATE TABLE ${table} (${defs.join(', ')}${pks.length ? `, PRIMARY KEY (${pks.join(',')})` : ''}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`)
  for (const r of rows) {
    const vals = colNames.map((n) => {
      const v = r[n]
      if (v === null) return 'NULL'
      if (bool.has(n)) return v === 'true' ? '1' : '0'
      if (/^-?\d+$/.test(String(v))) return String(v)
      return `'${esc(v)}'`
    })
    sqlLines.push(`INSERT INTO ${table} (${colNames.join(', ')}) VALUES (${vals.join(', ')});`)
  }
  // 导出对应 JSON
  fs.writeFileSync(path.join(OUT_DIR, `${table}.json`), JSON.stringify(rows, null, 2))
  sqlLines.push('')
  console.log(`${table}: ${rows.length} 行`)
}

fs.writeFileSync(path.join(OUT_DIR, 'dump.sql'), sqlLines.join('\n'))
console.log(`\n导出完成 → ${OUT_DIR}/(dump.sql + 各表 .json)`)
db.close()
