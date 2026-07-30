// 会话认证:JWT 签名的 HttpOnly Cookie
import { sign, verify } from 'hono/jwt'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomBytes } from 'node:crypto'

const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex')
if (!process.env.JWT_SECRET) {
  console.warn('警告: 未设置 JWT_SECRET,已生成临时密钥,重启后所有登录会失效')
}

const COOKIE_NAME = 'session'
const SESSION_DAYS = 30

export async function createSession(c, user) {
  const token = await sign(
    { uid: user.id, name: user.name, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 },
    JWT_SECRET
  )
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  })
}

export function clearSession(c) {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

// 中间件:解析会话,把当前用户挂到 c.var.user(未登录为 null)
export async function sessionMiddleware(c, next) {
  let user = null
  const token = getCookie(c, COOKIE_NAME)
  if (token) {
    try {
      const payload = await verify(token, JWT_SECRET, 'HS256')
      user = { id: payload.uid, name: payload.name }
    } catch {
      // 过期或无效的会话按未登录处理
    }
  }
  c.set('user', user)
  await next()
}

// 中间件:要求已登录
export async function requireAuth(c, next) {
  if (!c.get('user')) return c.json({ error: '请先登录' }, 401)
  await next()
}
