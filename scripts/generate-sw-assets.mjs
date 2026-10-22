import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
const root = new URL('../dist/', import.meta.url)
const assets = []
async function walk(relative = '') {
  for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) {
      if (!name.startsWith('.')) await walk(name + '/')
    } else if (/\.(?:html|css|js|png|jpg|jpeg|svg|webp|woff2?)$/.test(name) && name !== 'sw.js')
      assets.push('/' + name)
  }
}
await walk()
assets.sort()
const hash = createHash('sha256')
for (const asset of assets)
  hash
    .update(asset)
    .update('\0')
    .update(await readFile(new URL('.' + asset, root)))
const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
hash.update(template)
if (!template.includes('/* BUILD_CACHE */') || !template.includes('/* BUILD_SHELL */'))
  throw new Error('SW 模板缺少构建占位符')
const result = template
  .replace(
    /\/\* BUILD_CACHE \*\/ 'couple-blog-shell-development'/,
    JSON.stringify(`couple-blog-shell-${hash.digest('hex').slice(0, 16)}`),
  )
  .replace('/* BUILD_SHELL */ []', JSON.stringify(assets))
await writeFile(new URL('sw.js', root), result)
await writeFile(new URL('shell-assets.json', root), JSON.stringify(assets, null, 2) + '\n')
console.log(`离线壳已生成：${assets.length} 项，包含全部 chunk 与 Worker。`)
