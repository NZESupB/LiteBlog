// 草稿存储独立于编辑器 DOM；调用时读取当前用户，不保存账号快照。
export function createDraftStorage(getUserId, onSave = () => {}) {
  const composeDraftKey = (draftId) => `compose-draft:${location.origin}:${getUserId() || 'guest'}:${draftId}`
  const readComposeState = (draftId) => {
    try {
      const raw = localStorage.getItem(composeDraftKey(draftId))
      if (raw) return JSON.parse(raw)
      if (!String(draftId).startsWith('post-')) {
        const legacy = sessionStorage.getItem(`compose-draft:${getUserId() || 'guest'}`)
        return legacy ? { content: legacy } : null
      }
      return null
    } catch { return null }
  }
  const saveComposeState = (draftId, state) => {
    try {
      localStorage.setItem(composeDraftKey(draftId), JSON.stringify({ ...state, savedAt: new Date().toISOString() }))
      onSave(true)
    } catch { onSave(false) }
  }
  const clearComposeState = (draftId) => {
    try {
      localStorage.removeItem(composeDraftKey(draftId))
      sessionStorage.removeItem(`compose-draft:${getUserId() || 'guest'}`)
    } catch {}
  }
  let databasePromise
  const draftFileDb = () => {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { resolve(null); return }
      const request = indexedDB.open('couple-blog-drafts', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch(() => null)
    return databasePromise
  }
  const update = async (callback) => {
    const db = await draftFileDb()
    if (!db) return false
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite')
      callback(transaction.objectStore('files'))
      transaction.oncomplete = resolve
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('草稿文件写入失败'))
    })
    return true
  }
  const saveDraftFile = (draftId, file) => file?._id ? update((store) => {
    store.put({ key: `${draftId}:${file._id}`, draftId, id: file._id, name: file.name, type: file.type, blob: file })
  }) : Promise.resolve(false)
  const loadDraftFiles = async (draftId) => {
    const db = await draftFileDb()
    if (!db) return []
    return new Promise((resolve, reject) => {
      const request = db.transaction('files', 'readonly').objectStore('files').getAll()
      request.onsuccess = () => resolve(request.result.filter((row) => row.draftId === draftId).map((row) => Object.assign(new File([row.blob], row.name, { type: row.type }), { _id: row.id })))
      request.onerror = () => reject(request.error)
    })
  }
  const clearDraftFiles = (draftId) => update((store) => {
    const request = store.getAllKeys()
    request.onsuccess = () => { for (const key of request.result) if (String(key).startsWith(`${draftId}:`)) store.delete(key) }
  })
  const removeDraftFile = (draftId, id) => id ? update((store) => store.delete(`${draftId}:${id}`)) : Promise.resolve(false)
  return { readComposeState, saveComposeState, clearComposeState, draftFileDb, saveDraftFile, loadDraftFiles, clearDraftFiles, removeDraftFile }
}
