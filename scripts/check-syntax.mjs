import { readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const files = []
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) visit(filename)
    else if (/\.(?:js|mjs)$/.test(filename)) files.push(filename)
  }
}
for (const directory of ['server', 'scripts', 'frontend/src', 'tests']) visit(directory)
for (const filename of ['public/sw.js', 'public/js/theme.js', 'eslint.config.js']) files.push(filename)
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log(`语法校验通过：${files.length} 个 JavaScript 文件。`)
