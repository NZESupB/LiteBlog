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
      if (!window.indexedDB) {
        reject(new DOMException('浏览器不支持媒体草稿缓存', 'NotSupportedError'))
        return
      }
      const request = indexedDB.open('couple-blog-drafts', 1)
      let blocked = false
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'key' })
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => { db.close(); databasePromise = undefined }
        resolve(db)
      }
      request.onerror = () => reject(request.error || new Error('无法打开媒体草稿缓存'))
      request.onblocked = () => {
        blocked = true
        reject(new Error('媒体草稿缓存被其他页面占用，请关闭旧页面后重试'))
      }
    }).catch((error) => { databasePromise = undefined; throw error })
    return databasePromise
  }
  const update = async (callback) => {
    const db = await draftFileDb()
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite')
      transaction.oncomplete = resolve
      transaction.onerror = (event) => reject(event.target?.error || transaction.error || new Error('草稿文件写入失败'))
      transaction.onabort = () => reject(transaction.error || new Error('草稿文件写入已中止'))
      try { callback(transaction.objectStore('files')) }
      catch (error) { transaction.abort(); reject(error) }
    })
    return true
  }
  const saveDraftFile = (draftId, file) => file?._id ? update((store) => {
    store.put({ key: `${draftId}:${file._id}`, draftId, id: file._id, name: file.name, type: file.type, lastModified: file.lastModified, blob: file })
  }) : Promise.resolve(false)
  const loadDraftFiles = async (draftId) => {
    const db = await draftFileDb()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly')
      const request = transaction.objectStore('files').getAll()
      let rows = []
      request.onsuccess = () => { rows = request.result }
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error || new Error('草稿文件读取已中止'))
      transaction.oncomplete = () => {
        try {
          resolve(rows.filter((row) => row.draftId === draftId).map((row) => Object.assign(new File([row.blob], row.name, { type: row.type, lastModified: row.lastModified }), { _id: row.id })))
        } catch (error) { reject(error) }
      }
    })
  }
  const clearDraftFiles = (draftId) => update((store) => {
    const request = store.getAllKeys()
    request.onsuccess = () => { for (const key of request.result) if (String(key).startsWith(`${draftId}:`)) store.delete(key) }
  })
  const removeDraftFile = (draftId, id) => id ? update((store) => store.delete(`${draftId}:${id}`)) : Promise.resolve(false)
  return { readComposeState, saveComposeState, clearComposeState, draftFileDb, saveDraftFile, loadDraftFiles, clearDraftFiles, removeDraftFile }
}
