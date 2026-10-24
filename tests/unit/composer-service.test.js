import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createComposerService } from '../../frontend/src/features/composer/composer-service.js'
vi.mock('../../frontend/src/native/video-upload.js', () => ({
  uploadVideo: vi.fn(),
  waitForVideoUpload: vi.fn(),
  cancelVideoUpload: vi.fn(),
  retryVideoUpload: vi.fn(),
  selectVideoVariant: vi.fn(),
  formatVideoElapsed: () => '',
}))
import { cancelVideoUpload, waitForVideoUpload, selectVideoVariant } from '../../frontend/src/native/video-upload.js'
const services = []
beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
})
function setup(saved = {}, remote = { draft: { status: 'active' }, videoJobs: [] }, post = null) {
  const storage = {
    readComposeState: () => saved,
    saveComposeState: vi.fn(),
    clearComposeState: vi.fn(),
    loadDraftFiles: async () => [],
    clearDraftFiles: vi.fn(),
    removeDraftFile: vi.fn(),
  }
  const request = vi.fn(async (path, options = {}) =>
    options.method === 'POST' && path === '/api/posts'
      ? { id: 42 }
      : path === '/api/drafts/test' && !options.method
        ? remote
        : { ok: true },
  )
  const onPublished = vi.fn(),
    onNotice = vi.fn()
  const service = createComposerService({
    userId: 1,
    post,
    draftId: 'test',
    storage,
    request,
    onPublished,
    onNotice,
  })
  services.push(service)
  return { service, storage, request, onPublished, onNotice }
}
it('编辑重开不会把已挂到文章的视频任务重复加入草稿', async () => {
  const { service } = setup(
    {},
    {
      videoJobs: [
        { uploadId: 'published-video', needsPoster: true, status: 'done', filename: 'published.mp4' },
      ],
    },
    { id: 7, content: '已发布', images: [{ id: 9, type: 'video', url: '/uploads/published.mp4' }] },
  )
  await service.start()
  expect(service.getState().keep).toHaveLength(1)
  expect(service.getState().files).toHaveLength(0)
})
describe('发布器业务生命周期', () => {
  it('兼容原有正文、公开开关和草稿媒体，关闭不删除远端草稿', async () => {
    const { service, request, storage } = setup({
      content: '原草稿',
      publicText: true,
      files: [{ id: 'still', filename: 'a.jpg', kind: 'image' }],
    })
    await service.start()
    expect(service.getState().content).toBe('原草稿')
    expect(service.getState().publicText).toBe(true)
    service.dispose()
    expect(request.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false)
    expect(storage.saveComposeState.mock.calls.at(-1)[1].files[0].id).toBe('still')
  })
  it('初始化失败保留原草稿且阻止发布', async () => {
    const { service, storage, request } = setup({ content: '不能丢失' })
    request.mockRejectedValue(new Error('离线'))
    await service.start()
    service.set('content', '本次修改')
    await service.publish()
    expect(service.publishGuard()).toContain('恢复失败')
    expect(storage.saveComposeState).not.toHaveBeenCalled()
    expect(storage.clearComposeState).not.toHaveBeenCalled()
  })
  it('上传原件指纹和任务 ID 在恢复和持久化中保持一致', async () => {
    waitForVideoUpload.mockImplementation(async (_id, options) => {
      options.onState({
        uploadId: 'job',
        clientUploadId: 'client',
        fingerprint: 'sha256',
        phase: 'compressing',
      })
      return { filename: 'a.mp4', status: 'done' }
    })
    const { service, storage } = setup(
      {
        files: [
          { id: 'video', kind: 'video', videoJobId: 'job', clientUploadId: 'client', fingerprint: 'sha256' },
        ],
      },
      { videoJobs: [{ uploadId: 'job', needsPoster: true, status: 'queued' }] },
    )
    await service.start()
    await vi.waitFor(() => expect(service.getState().files[0]._status).toBe('done'))
    expect(waitForVideoUpload).toHaveBeenCalledWith(
      'job',
      expect.objectContaining({ clientUploadId: 'client', fingerprint: 'sha256' }),
    )
    expect(storage.saveComposeState.mock.calls.at(-1)[1].files[0]).toMatchObject({
      videoJobId: 'job',
      clientUploadId: 'client',
      fingerprint: 'sha256',
    })
  })
  it('实况降级取消失败仍阻止发布并保留配对身份', async () => {
    cancelVideoUpload.mockRejectedValueOnce(new Error('网络错误'))
    const { service } = setup({
      files: [
        {
          id: 'live',
          kind: 'image',
          filename: 'a.jpg',
          motion: 'a.mov',
          motionJobId: 'motion',
          needsReview: true,
        },
      ],
    })
    await service.start()
    await service.keepStill(service.getState().files[0])
    expect(service.publishGuard()).toContain('待确认')
    expect(service.getState().files[0]._motion._videoJobId).toBe('motion')
  })
  it('发布只提交媒体名，缓存清理失败不改变成功结果', async () => {
    const { service, storage, request, onPublished, onNotice } = setup({
      content: '今天',
      files: [{ id: 'live', filename: 'a.jpg', motion: 'a.mov', kind: 'image' }],
    })
    storage.clearDraftFiles.mockRejectedValue(new Error('缓存拒绝'))
    await service.start()
    await service.publish()
    const body = JSON.parse(request.mock.calls.find(([path]) => path === '/api/posts')[1].body)
    expect(body).toMatchObject({
      draftId: 'test',
      content: '今天',
      images: [{ filename: 'a.jpg', motion: 'a.mov' }],
    })
    expect(onPublished).toHaveBeenCalledWith({ id: 42 })
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('缓存清理失败'))
    expect(service.getState().busy).toBe(false)
  })
  it('明确丢弃只有远端删除成功后才清除本地草稿', async () => {
    const { service, storage, request } = setup({ content: '待保留' })
    await service.start()
    request.mockRejectedValueOnce(new Error('删除失败'))
    expect(await service.discard()).toBe(false)
    expect(storage.clearComposeState).not.toHaveBeenCalled()
    expect(await service.discard()).toBe(true)
    expect(storage.clearComposeState).toHaveBeenCalledWith('test')
  })
  it('空白草稿不会发送发布请求', async () => {
    const { service, request } = setup()
    await service.start()
    await service.publish()
    expect(request.mock.calls.some(([path]) => path === '/api/posts')).toBe(false)
    expect(service.getState().error).toContain('写点什么')
  })
})

describe('原件就绪与后台压缩', () => {
  const original = {
    uploadId: 'job', status: 'compressing', originalReady: true, compressionPending: true,
    filename: 'original.mp4', poster: 'poster.jpg', selectedVariant: 'original', selectionSource: 'auto',
    variants: { original: { filename: 'original.mp4', codec: 'h264' } },
  }
  function restore(job = original, live = false) {
    return setup({ content: '可发布', files: [live
      ? { id: 'live', kind: 'image', filename: 'still.jpg', motionJobId: 'job' }
      : { id: 'video', kind: 'video', videoJobId: 'job' }],
    }, { videoJobs: [{ ...job, needsPoster: !live }] })
  }
  it('压缩尚未结束时原件可立即发布，卸载仅停止轮询', async () => {
    waitForVideoUpload.mockImplementation((_id, options) => options.waitForCompression
      ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
      : Promise.resolve(original))
    const { service, request, storage } = restore()
    await service.start()
    expect(service.publishGuard()).toBe('')
    expect(service.getState().files[0]).toMatchObject({ _status: 'done', _originalReady: true, _name: 'original.mp4' })
    expect(storage.saveComposeState.mock.calls.at(-1)[1].files[0].originalReady).toBe(true)
    await service.publish()
    expect(JSON.parse(request.mock.calls.find(([url]) => url === '/api/posts')[1].body).images).toEqual([
      { filename: 'original.mp4', poster: 'poster.jpg' },
    ])
    service.dispose()
    expect(cancelVideoUpload).not.toHaveBeenCalled()
  })
  it('后台压缩失败不撤销原件的发布资格', async () => {
    waitForVideoUpload.mockImplementation(async (_id, options) => {
      if (options.waitForCompression) throw Object.assign(new Error('压缩暂停'), { canRetry: true })
      return original
    })
    const { service } = restore()
    await service.start()
    await vi.waitFor(() => expect(service.getState().files[0]._canRetry).toBe(true))
    expect(service.publishGuard()).toBe('')
    expect(service.getState().files[0]._videoResult).toMatchObject({ compressionPending: false, error: '压缩暂停' })
  })
  it('用户选原文件后迟到的自动选版轮询不会覆盖选择', async () => {
    let finish
    waitForVideoUpload.mockImplementation((_id, options) => options.waitForCompression
      ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(original))
    const { service } = restore()
    await service.start()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const item = service.getState().files[0]
    selectVideoVariant.mockResolvedValue({ ...original, selectionSource: 'user', selectionUpdatedAt: 42 })
    await service.selectVariant(item, 'original', true)
    finish({ ...original, status: 'done', compressionPending: false, filename: 'compressed.mp4', selectedVariant: 'compressed', selectionUpdatedAt: 0 })
    await vi.waitFor(() => expect(item._videoResult.selectionSource).toBe('user'))
    await Promise.resolve()
    expect(item._name).toBe('original.mp4')
    expect(service.publishGuard()).toBe('')
  })
  it('Live 配对原件就绪后可发布，未就绪时继续阻止', async () => {
    waitForVideoUpload.mockResolvedValue(original)
    const { service } = restore({ ...original, status: 'failed', compressionPending: false, error: '编码不支持' }, true)
    await service.start()
    expect(service.publishGuard()).toBe('')
    expect(service.getState().files[0]._motion._name).toBe('original.mp4')
    service.getState().files[0]._motion._status = 'uploading'
    expect(service.publishGuard()).toContain('处理中')
  })
})
