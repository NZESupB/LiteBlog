// 执行：node tests/image-config-regression.mjs。所有图片与 WebDAV 请求均由本地替身处理。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dataRoot = fileURLToPath(new URL('../data/', import.meta.url))
mkdirSync(dataRoot, { recursive: true })
const dataDir = mkdtempSync(`${dataRoot}image-config-regression-`)
const { setConfigForTests } = await import('../server/config.js')
setConfigForTests({
  server: { dataDir }, security: { jwtSecret: 'image-config-test' },
  ai: { image: { baseUrl: 'https://shared.test/v1', apiKey: 'initial-shared-key' } },
  storage: { webdav: { url: 'https://webdav.test', username: 'test', password: 'test' } },
})
const originalFetch = globalThis.fetch
let db
const calls = []
let failGeneration = false
globalThis.fetch = async (url, options = {}) => {
  const headers = new Headers(options.headers)
  calls.push({ url, key: headers.get('Authorization'), method: options.method || 'GET', body: options.body })
  if (url.startsWith('https://webdav.test/')) return new Response(null, { status: 201 })
  assert.match(url, /^https:\/\/(shared|custom1|custom2|candidate)\.test\/v1\/(models|images\/generations)$/)
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-image-2' }, { id: 'flux-image-pro' }] })
  if (failGeneration) return new Response('测试失败', { status: 503 })
  return Response.json({ data: [{ b64_json: Buffer.from('isolated-image-fixture').toString('base64') }] })
}
try {
  const { app } = await import('../server/index.js')
  ;({ db } = await import('../server/db.js'))
  const cookies = []
  async function request(user, route, method = 'GET', body) {
    return app.request(`/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookies[user] ? { Cookie: cookies[user] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  for (const id of [1, 2]) {
    const response = await request(id, 'login', 'POST', { username: `user${id}`, password: `pass${id}` })
    assert.equal(response.status, 200)
    cookies[id] = response.headers.get('set-cookie').split(';')[0]
    await request(id, 'drafts', 'POST', { id: `draft-${id}` })
  }
  async function config(user) {
    const response = await request(user, 'image-jobs/config')
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.doesNotMatch(text, /initial-shared-key|shared-key|custom-key|candidate-key|"apiKey"/)
    return JSON.parse(text)
  }
  const save = (user, body) => request(user, 'image-jobs/config', 'PUT', body)
  const test = (user, body) => request(user, 'image-jobs/config/test', 'POST', body)
  const models = (user, body) => request(user, 'image-jobs/config/models', 'POST', body)
  assert.equal((await request(0, 'image-jobs/config')).status, 401)
  for (const user of [1, 2]) {
    const initial = await config(user)
    assert.equal(initial.mode, 'shared')
    assert.equal(initial.shared.hasApiKey, true)
    assert.equal(initial.custom.hasApiKey, false)
    // 模型未显式配置时沿用默认值,独立来源为空
    assert.equal(initial.shared.model, 'gpt-image-2')
    assert.equal(initial.sharedModel, 'gpt-image-2')
    assert.equal(initial.custom.model, '')
  }
  // 共享来源的模型各自选择:首次保存补齐站点默认值,另一方仍可改回自己的选择
  assert.equal((await save(1, { mode: 'shared', model: 'flux-image-pro' })).status, 200)
  assert.equal((await config(1)).sharedModel, 'flux-image-pro')
  assert.equal((await config(2)).sharedModel, 'flux-image-pro', '站点默认模型跟随首次保存')
  assert.equal((await save(2, { mode: 'shared', model: 'gpt-image-2' })).status, 200)
  assert.equal((await config(2)).sharedModel, 'gpt-image-2')
  assert.equal((await config(1)).sharedModel, 'flux-image-pro', '另一方的模型选择不受影响')
  const modelList = await models(1, { mode: 'shared' })
  assert.equal(modelList.status, 200)
  assert.deepEqual((await modelList.json()).models, ['gpt-image-2', 'flux-image-pro'])
  assert.equal(calls.at(-1).key, 'Bearer initial-shared-key')
  assert.equal((await models(1, { mode: 'custom' })).status, 400, '独立来源未配置地址时不借用共享地址')
  // 旧客户端不带 mode 的保存，仍更新共享来源。
  assert.equal((await save(1, { baseUrl: 'https://shared.test/v1/', apiKey: 'shared-key' })).status, 200)
  assert.equal((await test(2, { mode: 'shared' })).status, 200)
  assert.equal(calls.at(-1).key, 'Bearer shared-key')
  assert.equal((await save(1, { mode: 'custom', baseUrl: 'https://custom1.test/v1', apiKey: 'custom-key-1', model: 'custom-image-model' })).status, 200)
  assert.equal((await config(1)).mode, 'custom')
  assert.equal((await config(1)).sharedModel, 'flux-image-pro', '独立模式下共享来源的模型不受影响')
  assert.equal((await config(2)).mode, 'shared')
  assert.equal((await config(2)).custom.baseUrl, '')
  assert.equal((await test(1, { mode: 'custom', apiKey: '' })).status, 200)
  assert.equal(calls.at(-1).key, 'Bearer custom-key-1')
  assert.equal((await save(1, { mode: 'custom', apiKey: '' })).status, 200)
  assert.equal((await test(1, { mode: 'shared' })).status, 200)
  assert.equal(calls.at(-1).key, 'Bearer shared-key')
  // 测试候选配置不改模式或任何已保存的配置。
  const before = await config(1)
  assert.equal((await test(1, { mode: 'shared', baseUrl: 'https://candidate.test/v1', apiKey: 'candidate-key' })).status, 200)
  assert.equal(calls.at(-1).key, 'Bearer candidate-key')
  assert.deepEqual(await config(1), before)
  assert.equal((await test(2, { mode: 'custom', baseUrl: 'https://custom2.test/v1' })).status, 400)
  assert.equal((await save(2, { mode: 'custom', baseUrl: 'https://custom2.test/v1' })).status, 200)
  assert.equal((await config(2)).custom.hasApiKey, false)
  assert.equal((await request(2, 'image-jobs', 'POST', { text: '不能借用共享 Key', draftId: 'draft-2' })).status, 400)
  assert.equal((await save(2, { mode: 'shared' })).status, 200)
  assert.equal((await save(1, { mode: 'invalid' })).status, 400)
  assert.equal((await save(1, { mode: 'custom', baseUrl: 'not-a-url' })).status, 400)
  assert.deepEqual(await config(1), before)

  async function settled(user, id) {
    for (let i = 0; i < 100; i++) {
      const { task } = await (await request(user, `image-jobs/${id}`)).json()
      if (['succeeded', 'failed'].includes(task.status)) return task
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.fail('后台任务未结束')
  }
  async function generate(user, text) {
    const response = await request(user, 'image-jobs', 'POST', { draftId: `draft-${user}`, text })
    assert.equal(response.status, 202)
    return settled(user, (await response.json()).task.id)
  }
  const generation = () => calls.filter((call) => call.url.endsWith('/images/generations')).at(-1)
  const customTask = await generate(1, '独立用户的日记')
  assert.equal(customTask.status, 'succeeded')
  assert.equal(generation().key, 'Bearer custom-key-1')
  assert.equal(JSON.parse(generation().body).model, 'custom-image-model', '生成使用该用户独立来源选择的模型')
  const sharedTask = await generate(2, '共享用户的日记')
  assert.equal(sharedTask.status, 'succeeded')
  assert.equal(generation().key, 'Bearer shared-key')
  assert.equal(JSON.parse(generation().body).model, 'gpt-image-2', '生成使用该用户共享来源选择的模型')
  failGeneration = true
  const failed = await generate(1, '待重试的日记')
  assert.equal(failed.status, 'failed')
  assert.equal((await request(2, `image-jobs/${failed.id}/retry`, 'POST')).status, 404)
  failGeneration = false
  await save(1, { mode: 'custom', apiKey: 'custom-key-retry' })
  assert.equal((await request(1, `image-jobs/${failed.id}/retry`, 'POST')).status, 202)
  assert.equal((await settled(1, failed.id)).status, 'succeeded')
  assert.equal(generation().key, 'Bearer custom-key-retry')
  assert.equal(JSON.parse(generation().body).model, 'custom-image-model', '重试沿用该作者当前来源的模型')
  await save(1, { mode: 'shared' })
  assert.equal((await generate(1, '切回共享的日记')).status, 'succeeded')
  assert.equal(generation().key, 'Bearer shared-key')
  assert.equal(JSON.parse(generation().body).model, 'flux-image-pro', '切回共享后使用该作者此前选择的共享模型')
  assert.equal((await config(1)).custom.hasApiKey, true)

  const unused = await generate(1, '生成但发布时不采用')
  const cleanupStart = calls.length
  const published = await request(1, 'posts', 'POST', { draftId: 'draft-1', content: '发布正文但不采用 AI 配图' })
  assert.equal(published.status, 200)
  const { task: cleaned } = await (await request(1, `image-jobs/${unused.id}`)).json()
  assert.equal(cleaned.status, 'cancelled')
  assert.ok(calls.slice(cleanupStart).some((call) => call.method === 'DELETE' && call.url.endsWith(`/ai-generated/${unused.filename}`)), '发布后未采用的 AI 配图要从 WebDAV 删除')
  console.log('通过：默认共享、旧配置兼容、双人独立隔离、空 Key 保留、候选测试不落库、密钥不回显、模型按人选择、生成与重试来源、未采用配图清理。')
} finally {
  globalThis.fetch = originalFetch
  db?.close()
  rmSync(dataDir, { recursive: true, force: true })
}
