import { spawn } from 'node:child_process'
import { createServer } from 'vite'
const backend = spawn(process.execPath, ['--watch', 'server/index.js'], { stdio: 'inherit' })
const frontend = await createServer({ configFile: 'frontend/vite.config.ts' })
await frontend.listen()
frontend.printUrls()
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  backend.kill('SIGTERM')
  await frontend.close()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
backend.once('exit', () => {
  if (!stopping) {
    process.exitCode = 1
    void stop()
  }
})
