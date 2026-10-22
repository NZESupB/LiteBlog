import { initializeStorage, closeDatabase } from './db.js'
import { initializeImageJobs, stopImageJobs } from './image-jobs.js'
import { startVideoJobs, stopVideoJobs } from './video-jobs.js'
import { startBackupScheduler, stopBackupScheduler, waitForBackup } from './backup.js'
import { beginMaintenance, endMaintenance } from './maintenance.js'

let initialization = null
export async function initializeRuntime({ schedule = false } = {}) {
  if (!initialization)
    initialization = (async () => {
      initializeStorage()
      initializeImageJobs()
      await startVideoJobs()
    })().catch((error) => {
      initialization = null
      throw error
    })
  await initialization
  if (schedule) startBackupScheduler()
}
// HTTP 监听先关闭并排空，再停止任务；推送等数据库回调也必须退出。
export async function stopRuntime() {
  stopBackupScheduler()
  await Promise.all([stopVideoJobs(), stopImageJobs(), waitForBackup()])
  try {
    await beginMaintenance()
    closeDatabase()
    initialization = null
  } finally {
    endMaintenance()
  }
}
