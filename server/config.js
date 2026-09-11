// 实例配置优先从仓库根目录的 config.json 读取，没有配置时回退到 Docker Compose environment。
// 真实 config.json 不进 Git，也不通过静态资源或 API 暴露。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json')

let rawConfig = {}
if (existsSync(CONFIG_PATH)) {
  try {
    rawConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}
  } catch (error) {
    throw new Error(`读取 config.json 失败: ${error.message}`)
  }
}

const ENV_KEYS = {
  'server.port': 'PORT',
  'server.dataDir': 'DATA_DIR',
  'site.title': 'SITE_TITLE',
  'site.anniversary': 'ANNIVERSARY',
  'site.privateMode': 'PRIVATE_MODE',
  'security.jwtSecret': 'JWT_SECRET',
  'storage.backend': 'STORAGE_BACKEND',
  'storage.webdav.url': 'WEBDAV_URL',
  'storage.webdav.username': 'WEBDAV_USERNAME',
  'storage.webdav.password': 'WEBDAV_PASSWORD',
  'storage.webdav.folder': 'WEBDAV_FOLDER',
  'ai.image.baseUrl': 'IMAGE_API_BASE_URL',
  'ai.image.apiKey': 'IMAGE_API_KEY',
  'ai.llm.baseUrl': 'LLM_BASE_URL',
  'ai.llm.model': 'LLM_MODEL',
  'ai.llm.apiKey': 'LLM_API_KEY',
  'push.vapidSubject': 'VAPID_SUBJECT',
}

export function configValue(pathName, fallback = '') {
  const value = String(pathName).split('.').reduce((current, key) => current?.[key], rawConfig)
  if (value !== undefined && value !== null) return value
  const envKey = ENV_KEYS[pathName]
  return envKey && process.env[envKey] !== undefined ? process.env[envKey] : fallback
}

// 仅供无测试框架的集成测试在导入数据库前注入隔离配置。
export function setConfigForTests(nextConfig) {
  rawConfig = nextConfig && typeof nextConfig === 'object' ? nextConfig : {}
}
