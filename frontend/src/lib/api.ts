export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = '',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' })
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ApiError(`服务器返回无效响应 (${response.status})`, response.status)
  }
  if (!response.ok) {
    const body = data as { error?: string; message?: string; code?: string }
    throw new ApiError(
      body.error || body.message || `请求失败 (${response.status})`,
      response.status,
      body.code,
    )
  }
  return data as T
}
export function json<T>(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  return api<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
}
