// AI 优化(LLM 代理:凭据只存服务端,前端不接触 API Key)
// 以子应用形式挂在 /api/llm 下,配置读写、模型列表、连通性测试、SSE 流式优化都在本文件。
import { Hono } from 'hono'
import { db, getSetting, setSetting, getUserSetting, setUserSetting } from './db.js'
import { requireAuth } from './auth.js'

export const llmApp = new Hono()

// LLM 配置读写:共享 API + 个人模型,或用户独立 API。旧 default 模式兼容为 shared。
llmApp.get('/', requireAuth, (c) => {
  const me = c.get('user')
  const shared = sharedLlmConfig()
  return c.json({
    mode: llmMode(me.id),
    shared: {
      baseUrl: shared.baseUrl,
      model: shared.model,
      hasApiKey: Boolean(shared.apiKey),
    },
    // 兼容旧客户端:global 与 shared 指向同一份共享配置,仍不返回明文 Key。
    global: {
      baseUrl: shared.baseUrl,
      model: shared.model,
      hasApiKey: Boolean(shared.apiKey),
    },
    sharedModel: getUserSetting(me.id, 'llm_shared_model', shared.model),
    custom: {
      baseUrl: getUserSetting(me.id, 'llm_base_url', ''),
      model: getUserSetting(me.id, 'llm_model', ''),
      hasApiKey: Boolean(getUserSetting(me.id, 'llm_api_key', '')),
    },
  })
})

llmApp.put('/', requireAuth, async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const cfg = draftLlmConfig(me.id, body)
  if (!isLlmBaseUrl(cfg.baseUrl)) {
    return c.json({ error: cfg.mode === 'shared' ? '请先配置共享接口地址(以 http:// 或 https:// 开头)' : '请填写合法的接口地址(以 http:// 或 https:// 开头)' }, 400)
  }

  if (cfg.mode === 'shared') {
    const sharedBaseUrl = String(body.sharedBaseUrl ?? body.baseUrl ?? '').trim()
    const sharedApiKey = String(body.sharedApiKey ?? body.apiKey ?? '').trim()
    if (sharedBaseUrl) setSetting('llm_base_url', sharedBaseUrl)
    if (sharedApiKey) setSetting('llm_api_key', sharedApiKey)
    // 保留旧的全局模型作为尚未选择个人模型时的回退,兼容已有环境变量配置。
    if (!sharedLlmConfig().model && cfg.model) setSetting('llm_model', cfg.model)
    setUserSetting(me.id, 'llm_shared_model', cfg.model)
  } else {
    setUserSetting(me.id, 'llm_base_url', cfg.baseUrl)
    setUserSetting(me.id, 'llm_model', cfg.model)
    if (String(body.apiKey ?? '').trim()) setUserSetting(me.id, 'llm_api_key', cfg.apiKey)
  }
  setUserSetting(me.id, 'llm_mode', cfg.mode)
  return c.json({ ok: true })
})

// 自动获取模型列表:凭据由当前用户选中的共享/独立配置在服务端解析,不要求前端回传已保存的 Key。
llmApp.post('/models', requireAuth, async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const cfg = draftLlmConfig(me.id, body)
  if (!isLlmBaseUrl(cfg.baseUrl)) return c.json({ error: '请先填写合法的接口地址' }, 400)
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/models'
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } }).catch(() => null)
  if (!res) return c.json({ error: '无法连接接口地址' }, 400)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return c.json({ error: `获取模型失败 (${res.status}): ${t.slice(0, 120)}` }, 400)
  }
  const data = await res.json().catch(() => null)
  const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
  return c.json({ models })
})

// 测试连通性:只验证当前表单中的候选配置,不修改任何已保存的配置。
llmApp.post('/test', requireAuth, async (c) => {
  const me = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const cfg = draftLlmConfig(me.id, body)
  if (!isLlmBaseUrl(cfg.baseUrl)) return c.json({ ok: false, message: '请先填写合法的接口地址' }, 400)
  const r = await llmChat(cfg, '请回复「ok」', true).catch((e) => ({ ok: false, message: e.message }))
  return c.json(r, r.ok ? 200 : 400)
})

// AI 优化:接收正文,以 SSE 流式返回优化后的 Markdown(按当前用户生效配置)。
// 上游连不通时仍走普通 JSON 错误响应,前端沿用原有错误处理。
llmApp.post('/polish', requireAuth, async (c) => {
  const { text } = await c.req.json().catch(() => ({}))
  const content = String(text ?? '').trim()
  if (!content) return c.json({ error: '正文为空,无需优化' }, 400)
  const cfg = llmConfig(c.get('user').id)
  if (!cfg.baseUrl) {
    return c.json({
      code: 'LLM_NOT_CONFIGURED',
      error: '尚未配置 AI 优化接口,请到站点设置填写',
    }, 400)
  }
  let upstream
  try {
    upstream = await llmChatStream(cfg, polishPrompt(content))
  } catch (e) {
    return c.json({ error: e.message || 'AI 优化失败' }, 400)
  }
  return new Response(sseFromUpstream(upstream), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 反代(nginx)下禁用缓冲,否则流式会被攒成一整块
    },
  })
})

function polishPrompt(content) {
  return `你是一位温暖细腻的日记优化助手。请把下面的 Markdown 日记正文优化得更好。

【必须保持】
- 第一人称视角、原意与真实情感,不新增事实,不编造细节
- 所有图片链接与外部链接必须原样保留,不得改动或丢失
- 原有 Markdown 结构(标题、列表、引用、加粗、分割线等)整体保留并理顺

【优化方向】
- 口语化、自然真诚,像本人随手写下的文字,避免书面腔与 AI 味
- 修正错别字、病句与啰嗦的表达,让句子流畅有节奏
- 过长的段落可适度拆分,让排版更易读
- 可用少量 emoji 点缀情感(整篇不超过 5 个、位置自然),不强行堆砌

【语气】
- 顺着原文的情绪走:开心的轻快活泼,平淡的克制温和,难过的安静不煽情

【输出要求】
- 只输出优化后的完整 Markdown 正文,不要任何解释、前言或结尾
- 不要用代码块包裹,直接输出正文

待优化正文:
${content}`
}

function isLlmBaseUrl(value) {
  return /^https?:\/\/\S+/.test(value)
}

function llmMode(userId) {
  return getUserSetting(userId, 'llm_mode', 'shared') === 'custom' ? 'custom' : 'shared'
}

function sharedLlmConfig() {
  return {
    baseUrl: getSetting('llm_base_url', process.env.LLM_BASE_URL || ''),
    model: getSetting('llm_model', process.env.LLM_MODEL || ''),
    apiKey: getSetting('llm_api_key', process.env.LLM_API_KEY || ''),
  }
}

// 表单可带尚未保存的地址/密钥;留空时沿用对应来源中已保存的值。
function draftLlmConfig(userId, body) {
  const mode = body.mode === 'custom' ? 'custom' : 'shared'
  const saved = mode === 'custom'
    ? {
        baseUrl: getUserSetting(userId, 'llm_base_url', ''),
        model: getUserSetting(userId, 'llm_model', ''),
        apiKey: getUserSetting(userId, 'llm_api_key', ''),
      }
    : (() => {
        const shared = sharedLlmConfig()
        return { ...shared, model: getUserSetting(userId, 'llm_shared_model', shared.model) }
      })()
  const baseUrl = String(mode === 'custom' ? body.baseUrl ?? '' : body.sharedBaseUrl ?? body.baseUrl ?? '').trim() || saved.baseUrl
  const apiKey = String(mode === 'custom' ? body.apiKey ?? '' : body.sharedApiKey ?? body.apiKey ?? '').trim() || saved.apiKey
  const model = String(body.model ?? '').trim() || saved.model
  return { mode, baseUrl, model, apiKey }
}

// 读取单一用户当前选择的配置, 不包含跨用户回退。
function directLlmConfig(userId) {
  if (llmMode(userId) === 'custom') {
    return {
      baseUrl: getUserSetting(userId, 'llm_base_url', ''),
      model: getUserSetting(userId, 'llm_model', ''),
      apiKey: getUserSetting(userId, 'llm_api_key', ''),
    }
  }
  const shared = sharedLlmConfig()
  return { ...shared, model: getUserSetting(userId, 'llm_shared_model', shared.model) }
}

// 当前用户未配置接口时, 回退到双人站点中另一方的当前生效配置。
function llmConfig(userId) {
  if (!userId) return sharedLlmConfig()
  const current = directLlmConfig(userId)
  if (current.baseUrl) return current
  const other = db.prepare('SELECT id FROM users WHERE id != ? ORDER BY id LIMIT 1').get(userId)
  if (!other) return current
  const fallback = directLlmConfig(other.id)
  return fallback.baseUrl ? fallback : current
}

function llmContentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.text?.value === 'string') return part.text.value
      return ''
    }).join('')
  }
  return ''
}

function llmMessageText(message) {
  return llmContentText(message?.content).trim()
}

// 调用兼容 OpenAI Chat Completions 的接口
async function llmChat(cfg, userText, isTest) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: userText }],
      stream: false,
      ...(isTest ? { max_tokens: 10 } : {}),
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`接口返回错误 (${res.status}): ${t.slice(0, 200)}`)
  }
  const data = await res.json().catch(() => null)
  const text = llmMessageText(data?.choices?.[0]?.message)
  // 测试连接只验证上游请求是否成功；优化则必须取得可写入正文的文本。
  if (!text && !isTest) throw new Error('接口未返回有效内容')
  return { ok: true, text }
}

// 流式调用:先拿到上游响应并校验状态,便于失败时仍以 JSON 报错而不是发一个空流
async function llmChatStream(cfg, userText) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: userText }],
      stream: true,
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`接口返回错误 (${res.status}): ${t.slice(0, 200)}`)
  }
  if (!res.body) throw new Error('接口未返回流式内容')
  return res
}

// 把上游 OpenAI 兼容 SSE 归一成本站协议:data:{"delta"} / data:{"error"} / data:[DONE]
function sseFromUpstream(upstream) {
  const encoder = new TextEncoder()
  const reader = upstream.body.getReader()
  return new ReadableStream({
    async start(ctrl) {
      // 流被取消后 desiredSize 为 null,再 enqueue 会抛 TypeError,写入前一律先检查
      const send = (obj) => {
        if (ctrl.desiredSize === null) return
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }
      const decoder = new TextDecoder()
      let buffer = ''
      let received = false
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // SSE 以空行分隔事件,末段可能不完整,留在缓冲里等下一个分片
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ''
          for (const block of blocks) {
            for (const line of block.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (!payload || payload === '[DONE]') continue
              let json = null
              try { json = JSON.parse(payload) } catch { continue }
              // 增量不能 trim,否则块间的换行与空格会被吞掉
              const delta = llmContentText(json?.choices?.[0]?.delta?.content)
              if (!delta) continue
              received = true
              send({ delta })
            }
          }
        }
        if (!received) send({ error: '接口未返回有效内容' })
      } catch (e) {
        send({ error: e.message || 'AI 优化中断' })
      }
      if (ctrl.desiredSize === null) return // 前端已断开,收尾帧无需再发
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'))
      ctrl.close()
    },
    cancel() {
      // 前端中止或断开时同步掐断上游,避免请求悬挂
      reader.cancel().catch(() => {})
    },
  })
}
