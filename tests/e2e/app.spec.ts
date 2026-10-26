import { test, expect, type Page } from '@playwright/test'
async function login(page: Page) {
  await page.goto('/#/login')
  await page.getByLabel('登录账号', { exact: true }).fill('user1')
  await page.getByLabel('密码', { exact: true }).fill('pass1')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '账号菜单' })).toBeVisible()
}
async function compose(page: Page) {
  await page.locator('.journal-heading-actions button').click()
  await expect(page.getByRole('dialog', { name: '写日常', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
}
test('React 发布、草稿重开、图片、评论与编辑', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await login(page)
  await compose(page)
  await page.getByLabel('动态正文').fill('React 迁移：一起记录今天。')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await compose(page)
  await expect(page.getByLabel('动态正文')).toHaveValue('React 迁移：一起记录今天。')
  await page.locator('.album-input').setInputFiles('public/images/journal-cover.jpg')
  await expect(page.locator('.preview-item .upload-badge')).toBeVisible()
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await expect(page.locator('.post-content')).toContainText('React 迁移')
  await page.getByRole('button', { name: '查看照片' }).first().click()
  await expect(page.locator('#lightbox')).toBeVisible()
  await page.locator('#lightbox .lb-close').click()
  await expect(page.locator('#lightbox')).not.toBeVisible()
  await page.getByRole('button', { name: '更多操作' }).first().click()
  await page.getByRole('button', { name: '评论', exact: true }).click()
  await page.getByLabel('评论内容').fill('评论流程正常')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.comment')).toContainText('评论流程正常')
  await page.getByRole('button', { name: '更多操作' }).first().click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('动态正文').fill('React 迁移：已编辑的日常。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await expect(page.locator('.post-content')).toContainText('已编辑的日常')
  expect(errors).toEqual([])
})
test('设置子路由、资料返回、明暗主题与窄屏布局', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await login(page)
  for (const path of ['site', 'ai', 'storage', 'backup']) {
    await page.goto(`/#/settings/${path}`)
    await expect(page.locator('main h1')).toBeVisible()
    await expect(page.locator('main')).not.toContainText('页面暂时无法打开')
    await expect(page.locator('main input').first()).toBeVisible()
    await page.getByRole('link', { name: '返回设置', exact: true }).click()
    await expect(page).toHaveURL(/#\/settings$/)
  }
  await page.goto('/#/settings')
  await page.locator('label.theme-option').filter({ hasText: '深色' }).click()
  await expect(page.getByRole('radio', { name: '深色', exact: true })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('link', { name: '编辑资料' }).click()
  await page.getByRole('link', { name: '返回设置' }).click()
  await expect(page).toHaveURL(/#\/settings$/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/settings/profile')
  await page.getByRole('link', { name: '返回设置', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings$/)
  await page.goto('/#/account')
  await page.getByRole('link', { name: '返回时间轴', exact: true }).click()
  await expect(page).toHaveURL(/#\/$/)
  await page.goto('/#/settings')
  await page.getByRole('link', { name: '返回时间轴', exact: true }).focus()
  await expect(page.getByRole('link', { name: '返回时间轴', exact: true })).toBeFocused()
  expect(
    await page
      .getByRole('link', { name: '返回时间轴', exact: true })
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/$/)
  await page.goto('/#/')
  await page.locator('.mobile-compose').click()
  await expect(page.locator('.composer-overlay')).toBeVisible()
  expect(
    await page.locator('.composer-dialog').evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.width <= innerWidth && box.left >= 0 && box.right <= innerWidth + 1
    }),
  ).toBe(true)
  expect(
    await page.locator('.md-toolbar').evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  expect(errors).toEqual([])
})
test('慢请求离页后不会覆盖新页面', async ({ page }) => {
  await login(page)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/gallery', async (route) => {
    await gate
    await route.fulfill({ json: { images: [] } }).catch(() => {})
  })
  await page.goto('/#/gallery')
  await expect(page.getByRole('heading', { name: '相册', exact: true })).toBeVisible()
  await page.locator('.site-title').click()
  release()
  await expect(page.locator('.journal-heading h1')).toHaveText('日常手记')
  await expect(page.locator('main')).not.toContainText('还没有照片')
})
test('构建资源离线闭包与私密请求不入缓存', async ({ page, context }) => {
  await page.goto('/#/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  const assets = (await (await page.request.get('/shell-assets.json')).json()) as string[]
  await context.setOffline(true)
  const results = await page.evaluate(
    async (urls) =>
      Promise.all(
        urls.map(async (url) => {
          const response = await fetch(url)
          return response.status
        }),
      ),
    assets,
  )
  expect(results.every((status) => status === 200)).toBe(true)
  await page.reload()
  await expect(page.locator('#root')).not.toBeEmpty()
  const cached = await page.evaluate(async () => {
    const keys: string[] = []
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys()) keys.push(new URL(request.url).pathname)
    return keys
  })
  expect(cached.some((url) => /^\/(api|uploads|avatars)\//.test(url))).toBe(false)
  await context.setOffline(false)
})

test('真实视频分片、后台处理、版本选择与发布', async ({ page }) => {
  await login(page)
  await compose(page)
  await page.getByLabel('动态正文').fill('视频迁移回归')
  const video = await page.request.get('/__test/video')
  expect(video.ok()).toBe(true)
  await page
    .locator('.album-input')
    .setInputFiles({ name: 'react-video.mp4', mimeType: 'video/mp4', buffer: await video.body() })
  await expect(page.locator('.video-comparison')).toBeVisible({ timeout: 30000 })
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
  const alternate = page.getByRole('button', { name: /采用原文件|采用压缩版本/ }).first()
  if (await alternate.count()) {
    await alternate.click()
    await expect(page.getByRole('button', { name: '发布', exact: true })).toBeEnabled()
  }
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await expect(page.locator('.post-content').first()).toContainText('视频迁移回归')
  expect(await page.locator('.media-tile video').count()).toBe(0)
  const mediaUrl = await page.locator('.media-tile.is-video').first().getAttribute('data-media-url')
  expect(mediaUrl).toMatch(/^\/uploads\//)
  const range = await page.request.get(mediaUrl!, { headers: { Range: 'bytes=0-15' } })
  expect(range.status()).toBe(206)
  expect((await range.body()).length).toBe(16)
})

test('播放器实际播放、失败提示与离页销毁', async ({ page }) => {
  await login(page)
  await page.route('**/api/gallery', (route) =>
    route.fulfill({
      json: {
        images: [
          {
            id: 9001,
            type: 'video',
            url: '/__test/playable.webm',
            author: 'user1',
            created_at: '2026-10-22 00:00:00',
          },
          {
            id: 9002,
            type: 'video',
            url: '/__test/invalid-video',
            author: 'user1',
            created_at: '2026-10-22 00:00:00',
          },
        ],
      },
    }),
  )
  await page.route('**/__test/invalid-video', (route) =>
    route.fulfill({ contentType: 'video/webm', body: 'invalid video' }),
  )
  await page.goto('/#/gallery')
  expect(await page.locator('.media-tile video').count()).toBe(0)
  await page.getByRole('button', { name: '播放视频' }).first().click()
  const player = page.locator('.is-playing video')
  await expect(player).toBeVisible()
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  await page.getByRole('button', { name: '收起视频' }).first().click()
  await expect(page.locator('.art-video')).toHaveCount(0)
  await page.getByRole('button', { name: '播放视频' }).nth(1).click()
  await expect(page.getByRole('status').filter({ hasText: '浏览器或设备无法解码此视频' })).toBeVisible()
  await expect(page.locator('.is-playing')).toHaveCount(0)
  await expect(page.locator('.art-video')).toHaveCount(0)
  await page.getByRole('button', { name: '播放视频' }).first().click()
  await expect(page.locator('.is-playing video')).toBeVisible()
  await page.goto('/#/settings')
  await expect(page.locator('.art-video')).toHaveCount(0)
})

test('Markdown、AI 流式对照与明确采用', async ({ page }) => {
  await login(page)
  await compose(page)
  await page.getByLabel('动态正文').fill('原始日常')
  await page.getByLabel('动态正文').evaluate((node: HTMLTextAreaElement) => {
    node.focus()
    node.setSelectionRange(0, 4)
  })
  await page.getByRole('button', { name: '加粗 (⌘B)', exact: true }).click()
  await expect(page.getByLabel('动态正文')).toHaveValue('**原始日常**')
  await page.route('**/api/llm/polish', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"reasoning":"先思考"}\n\ndata: {"delta":"优化后的日常"}\n\ndata: [DONE]\n\n',
    }),
  )
  await page.getByRole('button', { name: 'AI 优化', exact: true }).click()
  await expect(page.locator('.ai-result')).toHaveText('优化后的日常')
  await expect(page.getByLabel('动态正文')).toHaveValue('**原始日常**')
  await page.getByRole('button', { name: '采用优化', exact: true }).click()
  await expect(page.getByLabel('动态正文')).toHaveValue('优化后的日常')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
})

test('已有评论、回复、相册月份和访客内联图片边界', async ({ page, browser }) => {
  await login(page)
  const result = await page.request.post('/api/posts', {
    data: {
      content: '公开文字 ![私密图片](/images/journal-cover.jpg)',
      images: [],
      publicText: true,
      publicImages: false,
    },
  })
  const { id } = await result.json()
  await page.request.post(`/api/posts/${id}/comments`, { data: { content: '已有评论' } })
  await page.goto(`/#/post/${id}`)
  await expect(page.locator('.comment')).toContainText('已有评论')
  await expect(page.getByLabel('评论内容')).toHaveCount(0)
  await page.getByRole('button', { name: '回复', exact: true }).click()
  await page.getByLabel('评论内容').fill('回复已有评论')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.comment-reply-quote')).toHaveText('已有评论')
  const guest = await browser.newContext()
  const guestPage = await guest.newPage()
  await guestPage.goto(`http://127.0.0.1:4317/#/post/${id}`)
  await expect(guestPage.locator('.post-content')).toContainText('公开文字')
  await expect(guestPage.locator('.post-content img')).toHaveCount(0)
  await expect(guestPage.locator('.comment').first()).toContainText('已有评论')
  await guest.close()
  await page.goto('/#/gallery')
  await expect(page.locator('.gallery-month-heading').first()).toBeVisible()
})

test('设置真实保存、API 配置隔离和数据库恢复', async ({ page }) => {
  await login(page)
  await page.goto('/#/settings/ai')
  const ai = page
    .locator('form.settings-card')
    .filter({ has: page.getByRole('heading', { name: 'AI 优化', exact: true }) })
  await ai.getByRole('radio', { name: '使用独立 API' }).check()
  await ai.locator('input[name=baseUrl]').fill('https://example.invalid/v1')
  await ai.locator('input[name=customModel]').fill('test-model')
  await ai.getByLabel('思考强度').selectOption('high')
  await ai.getByRole('button', { name: '保存', exact: true }).click()
  await expect(ai.getByRole('status').last()).toHaveText('已保存')
  const config = await (await page.request.get('/api/llm')).json()
  expect(config.mode).toBe('custom')
  expect(config.custom.model).toBe('test-model')
  expect(config.thinking).toBe('high')
  await page.goto('/#/settings/storage')
  await page.getByLabel('WebDAV 地址').fill('http://127.0.0.1:9/')
  await page.getByLabel('用户名', { exact: true }).fill('test-user')
  await page.getByLabel('根目录').fill('react-images')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.reload()
  await expect(page.getByLabel('根目录')).toHaveValue('react-images')
  await page.goto('/#/settings/backup')
  await page.getByLabel('北京时间', { exact: true }).fill('04:15')
  await page.getByRole('button', { name: '保存备份计划' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/backups')).json()).time).toBe('04:15')
  const snapshot = await page.request.get('/__test/snapshot')
  expect(snapshot.ok()).toBe(true)
  await page.request.post('/api/posts', { data: { content: '恢复后不应存在', images: [] } })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByLabel('数据库文件').setInputFiles({
    name: 'restore.db',
    mimeType: 'application/octet-stream',
    buffer: await snapshot.body(),
  })
  await page.getByLabel('确认操作').fill('恢复')
  await page.getByRole('button', { name: '确认并恢复数据库' }).click()
  await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
  await login(page)
  expect(
    (await (await page.request.get('/api/posts')).json()).posts.some(
      (post: { content: string }) => post.content === '恢复后不应存在',
    ),
  ).toBe(false)
})

test('归档拖动松手仅请求一次，桌面写入口跟随滚动', async ({ page }) => {
  await login(page)
  await page.route('**/api/posts/archive?*', (route) =>
    route.fulfill({
      json: {
        months: [
          { month: '2026-10', count: 1 },
          { month: '2026-09', count: 1 },
        ],
        total: 2,
      },
    }),
  )
  const jumps: string[] = []
  await page.route('**/api/posts?*', (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    if (month) jumps.push(month)
    return route.fulfill({ json: { posts: [], hasMore: false, nextCursor: null, total: 2 } })
  })
  await page.reload()
  await expect(page.locator('.archive-rail button')).toHaveCount(2)
  await page.addStyleTag({ content: 'main { min-height: 2200px }' })
  await page.evaluate(() => window.scrollTo({ top: 800, behavior: 'instant' }))
  await expect(page.locator('#headerWrite')).toBeVisible()
  await page.locator('#headerWrite').click()
  await expect(page.locator('.composer-overlay')).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  const first = await page.locator('.archive-rail button').first().boundingBox()
  const last = await page.locator('.archive-rail button').last().boundingBox()
  expect(first).toBeTruthy()
  expect(last).toBeTruthy()
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2)
  await page.mouse.down()
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, { steps: 4 })
  expect(jumps).toEqual([])
  await page.mouse.up()
  await expect.poll(() => jumps).toEqual(['2026-09'])
})

test('Live 点击后持续循环，停止、切图和关闭释放视频', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await login(page)
  await page.route('**/api/gallery', (route) =>
    route.fulfill({
      json: {
        images: [
          {
            id: 9201,
            type: 'image',
            url: '/images/journal-cover.jpg',
            live: true,
            motion: '/__test/playable.webm',
            created_at: '2026-10-23 00:00:00',
          },
          {
            id: 9202,
            type: 'image',
            url: '/images/journal-cover.jpg?plain',
            created_at: '2026-10-23 00:00:00',
          },
        ],
      },
    }),
  )
  // 先注册 mock 再整页导航：只改 hash 不重载文档，慢机器上会与真实相册请求竞争，
  // 页面可能用真实数据渲染而没有 LIVE 格子（CI 曾因此空等到超时）。
  await page.goto('/#/gallery')
  await page.reload()
  const liveTile = page.locator('.media-tile').filter({ has: page.locator('.media-live') })
  await expect(liveTile).toHaveCount(1)
  await liveTile.getByRole('button', { name: '查看照片' }).click()
  await expect(page.locator('#lightboxLive')).toBeVisible()
  expect(await page.locator('#lightboxVideo').getAttribute('src')).toBeNull()
  await page.locator('#lightboxLive').click()
  const video = page.locator('#lightboxVideo')
  await expect(video).toBeVisible()
  expect(await video.evaluate((node: HTMLVideoElement) => node.loop)).toBe(true)
  await video.evaluate((node: HTMLVideoElement) => {
    let loops = 0,
      previous = node.currentTime
    node.dataset.loops = '0'
    node.addEventListener('timeupdate', () => {
      if (node.currentTime < previous) node.dataset.loops = String(++loops)
      previous = node.currentTime
    })
    node.playbackRate = 4
  })
  await expect.poll(async () => Number(await video.getAttribute('data-loops'))).toBeGreaterThanOrEqual(2)
  await expect(page.locator('#lightboxLive')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#lightboxLive').click()
  await expect(page.locator('#lightboxImg')).toBeVisible()
  expect(await video.getAttribute('src')).toBeNull()
  expect(await video.evaluate((node: HTMLVideoElement) => node.loop)).toBe(false)
  await page.locator('#lightboxLive').click()
  await expect(video).toBeVisible()
  await page.locator('#lightbox .lb-next').click()
  await expect(page.locator('#lightboxLive')).not.toBeVisible()
  expect(await video.getAttribute('src')).toBeNull()
  await page.locator('#lightbox .lb-close').click()
  await expect(page.locator('#lightbox')).not.toBeVisible()
  expect(errors).toEqual([])
})

const pickerPlatforms = [
  {
    name: 'iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    platform: 'iPhone',
    touch: 5,
    apple: true,
    ios: true,
    mobile: true,
  },
  {
    name: 'iPadOS 桌面标识',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
    platform: 'MacIntel',
    touch: 5,
    apple: true,
    ios: true,
    mobile: true,
  },
  {
    name: 'macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
    platform: 'MacIntel',
    touch: 0,
    apple: true,
    ios: false,
    mobile: false,
  },
  {
    name: 'Android',
    ua: 'Mozilla/5.0 (Linux; Android 15)',
    platform: 'Linux armv8l',
    touch: 5,
    apple: false,
    ios: false,
    mobile: true,
  },
  {
    name: 'Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    platform: 'Win32',
    touch: 0,
    apple: false,
    ios: false,
    mobile: false,
  },
  {
    name: 'Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
    touch: 0,
    apple: false,
    ios: false,
    mobile: false,
  },
]
for (const device of pickerPlatforms) {
  test(`${device.name} 媒体入口、文件选择与取消保护`, async ({ page }) => {
    await page.addInitScript((device) => {
      Object.defineProperties(navigator, {
        userAgent: { value: device.ua, configurable: true },
        platform: { value: device.platform, configurable: true },
        maxTouchPoints: { value: device.touch, configurable: true },
      })
    }, device)
    await login(page)
    await compose(page)
    await expect(page.locator('.toast').filter({ hasText: '正在打开写作面板' })).toHaveCount(0)
    await expect(page.locator('.pick-live-file')).toHaveCount(device.apple ? 1 : 0)
    await expect(page.locator('.camera-input')).toHaveCount(device.mobile ? 1 : 0)
    await expect(page.locator('.album-input')).toHaveAttribute(
      'accept',
      device.ios
        ? 'image/*'
        : device.mobile
          ? 'image/*,video/*'
          : 'image/*,video/*,.heic,.heif,.avif,.mov,.mp4',
    )
    await expect(page.locator('.album-input')).not.toHaveAttribute('capture')
    if (device.ios)
      await expect(page.locator('.live-photo-help')).toContainText('iOS系统下，仅能上传静态图片。')
    if (device.apple) {
      const choosing = page.waitForEvent('filechooser')
      await page.locator('.pick-live-file').click()
      const chooser = await choosing
      expect(await chooser.element().getAttribute('class')).toContain('originals-input')
      expect(chooser.isMultiple()).toBe(true)
      await chooser.setFiles([])
      await page.locator('.originals-input').dispatchEvent('cancel', { bubbles: true })
      await expect(page.locator('.composer-overlay')).toHaveAttribute('open', '')
      await expect(page.locator('.preview-item')).toHaveCount(0)
      await expect(page.locator('body')).toHaveClass(/modal-open/)
      await page.locator('.live-photo-guide summary').focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.live-photo-guide')).toHaveAttribute('open', '')
      await expect(page.locator('.live-photo-guide')).toContainText('同批选中原照片和配套 MOV')
    }
    await page.locator('.album-input').dispatchEvent('cancel', { bubbles: true })
    await expect(page.locator('.composer-overlay')).toHaveAttribute('open', '')
    await page.keyboard.press('Escape')
    await expect(page.locator('.composer-overlay')).toHaveCount(0)
    await expect(page.locator('body')).not.toHaveClass(/modal-open/)
  })
}

test('网页丢弃确认取消保留草稿、删除失败可重试、提交防重复', async ({ page }) => {
  const errors: string[] = []
  let nativeDialogs = 0
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', async (dialog) => {
    nativeDialogs++
    await dialog.dismiss()
  })
  await login(page)
  await compose(page)
  await page.getByLabel('动态正文').fill('丢弃确认前的正文')
  await page.locator('.album-input').setInputFiles('public/images/journal-cover.jpg')
  await expect(page.locator('.upload-badge')).toBeVisible()
  const discard = page.locator('.discard-draft')
  const confirmation = page.getByRole('alertdialog', { name: '确定丢弃这篇草稿？' })
  for (const action of ['button', 'escape', 'backdrop']) {
    await discard.click()
    await expect(confirmation).toBeVisible()
    await expect(confirmation.getByRole('button', { name: '继续编辑' })).toBeFocused()
    if (action === 'button') await confirmation.getByRole('button', { name: '继续编辑' }).click()
    else if (action === 'escape') await page.keyboard.press('Escape')
    else await page.locator('.confirm-overlay').click({ position: { x: 3, y: 3 } })
    await expect(confirmation).toHaveCount(0)
    await expect(page.getByLabel('动态正文')).toHaveValue('丢弃确认前的正文')
    await expect(page.locator('.upload-badge')).toBeVisible()
    await expect(discard).toBeFocused()
    await expect(page.locator('body')).toHaveClass(/modal-open/)
  }
  let deletes = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/drafts/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    deletes++
    if (deletes === 1) {
      await gate
      return route.fulfill({ status: 503, json: { error: '测试删除失败' } })
    }
    await route.continue()
  })
  await discard.click()
  await confirmation.getByRole('button', { name: '丢弃草稿', exact: true }).click()
  await expect(confirmation.getByRole('button', { name: '正在丢弃…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeVisible()
  expect(deletes).toBe(1)
  release()
  await expect(confirmation.getByRole('alert')).toContainText('测试删除失败')
  await expect(confirmation.getByRole('button', { name: '丢弃草稿', exact: true })).toBeEnabled()
  await confirmation.getByRole('button', { name: '继续编辑' }).click()
  await expect(page.getByLabel('动态正文')).toHaveValue('丢弃确认前的正文')
  await discard.click()
  await confirmation.getByRole('button', { name: '丢弃草稿', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/modal-open/)
  expect(deletes).toBe(2)
  await compose(page)
  await expect(page.getByLabel('动态正文')).toHaveValue('')
  await expect(page.locator('.preview-item')).toHaveCount(0)
  await discard.click()
  await page.evaluate(() => {
    location.hash = '#/settings'
  })
  await expect(page.locator('.confirm-overlay')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/modal-open/)
  expect(nativeDialogs).toBe(0)
  expect(errors).toEqual([])
})

test('Apple 文件入口同批配对照片与空 MIME MOV、重复选图', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      platform: { value: 'MacIntel', configurable: true },
      maxTouchPoints: { value: 5, configurable: true },
    })
  })
  await login(page)
  await compose(page)
  await page.getByLabel('动态正文').fill('文件入口 Live 双资源回归')
  const photo = await (await page.request.get('/images/journal-cover.jpg')).body()
  const movie = await (await page.request.get('/__test/video')).body()
  await page.locator('.originals-input').setInputFiles([
    { name: 'IMG_4321.jpg', mimeType: 'image/jpeg', buffer: photo },
    { name: 'IMG_4321.MOV', mimeType: '', buffer: movie },
  ])
  await expect(page.locator('.preview-item')).toHaveCount(1)
  await expect(page.locator('.preview-item .media-live')).toBeVisible()
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeEnabled({ timeout: 30000 })
  await expect(page.locator('.originals-input')).toHaveValue('')
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await expect(page.locator('.post-content').first()).toContainText('文件入口 Live 双资源回归')
  await expect(page.locator('.post').first().locator('.media-live')).toBeVisible()
  await compose(page)
  for (let count = 1; count <= 2; count++) {
    await page
      .locator('.originals-input')
      .setInputFiles({ name: 'repeat.jpg', mimeType: 'image/jpeg', buffer: photo })
    await expect(page.locator('.upload-badge')).toHaveCount(count)
    await expect(page.locator('.originals-input')).toHaveValue('')
  }
})

test('Apple 指南与网页确认的四种宽度、明暗和减少动态', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      platform: { value: 'MacIntel', configurable: true },
      maxTouchPoints: { value: 5, configurable: true },
    })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  for (const width of [320, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      const desktop = page.locator('.journal-heading-actions button')
      await ((await desktop.isVisible()) ? desktop : page.locator('.mobile-compose')).click()
      await expect(page.locator('.discard-draft')).toBeEnabled()
      await page.locator('.live-photo-guide summary').click()
      await expect(page.locator('.live-photo-guide')).toHaveAttribute('open', '')
      const file = page.locator('.pick-live-file')
      await file.scrollIntoViewIfNeeded()
      const box = (await file.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
      expect(
        await page.locator('.composer-body').evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true)
      await page.locator('.discard-draft').click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      const surface = (await page.locator('.confirm-dialog').boundingBox())!
      expect(surface.x).toBeGreaterThanOrEqual(0)
      expect(surface.x + surface.width).toBeLessThanOrEqual(width + 1)
      expect(
        await page.locator('.confirm-overlay').evaluate((node) => getComputedStyle(node).backgroundColor),
      ).not.toBe('rgba(0, 0, 0, 0)')
      await page.getByRole('button', { name: '继续编辑' }).click()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(page.locator('.composer-overlay')).toHaveCount(0)
    }
  }
})
