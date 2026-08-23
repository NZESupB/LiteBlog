// Web Push:VAPID(RFC 8292)签名 + aes128gcm 载荷加密(RFC 8291),只用 node:crypto 实现。
// 订阅表也放在这里,index.js 只调 saveSubscription / removeSubscription / pushToUser。
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { db, getSetting, setSetting } from './db.js'

const CURVE = 'prime256v1'
// 推送服务要求 sub 是可联系到发送方的 mailto: 或 https: URL(Apple 会校验)
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
// aes128gcm 的记录大小,单条通知远小于此值,固定成一条记录即可
const RECORD_SIZE = 4096

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (value) => Buffer.from(String(value), 'base64url')
// EC 私钥标量必须补齐到 32 字节,createECDH 在高位为 0 时会返回更短的 buffer
const pad32 = (buf) => (buf.length >= 32 ? buf.subarray(buf.length - 32) : Buffer.concat([Buffer.alloc(32 - buf.length), buf]))

// VAPID 密钥对只生成一次:换掉公钥会让所有已有订阅立即失效,必须落库长期保存
function vapidKeys() {
  let publicKey = getSetting('vapid_public')
  let privateKey = getSetting('vapid_private')
  if (!publicKey || !privateKey) {
    const ecdh = createECDH(CURVE)
    ecdh.generateKeys()
    publicKey = b64u(ecdh.getPublicKey())
    privateKey = b64u(pad32(ecdh.getPrivateKey()))
    setSetting('vapid_public', publicKey)
    setSetting('vapid_private', privateKey)
  }
  return { publicKey, privateKey }
}

export function vapidPublicKey() {
  return vapidKeys().publicKey
}

// ES256 的签名必须是裸 R||S,Node 默认输出 DER,靠 dsaEncoding 切换
function vapidAuthorization(endpoint) {
  const { publicKey, privateKey } = vapidKeys()
  const uncompressed = fromB64u(publicKey)
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(uncompressed.subarray(1, 33)), y: b64u(uncompressed.subarray(33, 65)), d: privateKey },
  })
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: SUBJECT,
  }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`
}

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
// HKDF-SHA256:单块输出足够(最长 32 字节),extract 后 expand 一次即可
const hkdf = (salt, ikm, info, length) => hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length)
const label = (text) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.alloc(1)])

// RFC 8291:临时 ECDH 与订阅公钥协商出 IKM,再派生内容密钥与 nonce
function encryptPayload(plaintext, p256dh, authSecret) {
  const uaPublic = fromB64u(p256dh)
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(uaPublic)

  const keyInfo = Buffer.concat([label('WebPush: info'), uaPublic, asPublic])
  const ikm = hkdf(fromB64u(authSecret), sharedSecret, keyInfo, 32)
  const salt = randomBytes(16)
  const cek = hkdf(salt, ikm, label('Content-Encoding: aes128gcm'), 16)
  const nonce = hkdf(salt, ikm, label('Content-Encoding: nonce'), 12)

  // 0x02 是最后一条记录的填充分隔符
  const record = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext])
}

export function saveSubscription(userId, { endpoint, p256dh, auth }) {
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, userId, p256dh, auth)
}

export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId)
}

// 给某个用户的所有设备推送。外部推送服务不可靠,失败只记日志,绝不影响调用方的业务流程。
export async function pushToUser(userId, payload) {
  const rows = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId)
  const body = JSON.stringify(payload)
  await Promise.all(rows.map(async (row) => {
    try {
      const res = await fetch(row.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(row.endpoint),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'normal',
        },
        body: encryptPayload(body, row.p256dh, row.auth),
      })
      // 404/410 是推送服务明确告知订阅已注销,留着只会每次都失败
      if (res.status === 404 || res.status === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint)
        return
      }
      if (!res.ok) console.warn(`推送失败 ${res.status}: ${(await res.text()).slice(0, 200)}`)
    } catch (e) {
      console.warn(`推送异常: ${e.message}`)
    }
  }))
}
