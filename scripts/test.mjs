import { spawnSync } from 'node:child_process'
const files = [
  'interface-regression',
  'composer-viewport-regression',
  'design-regression',
  'image-config-regression',
  'media-regression',
  'runtime-regression',
]
for (const name of files) {
  const result = spawnSync(process.execPath, [`tests/${name}.mjs`], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
