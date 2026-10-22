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
  await page.getByRole('menuitem', { name: '评论', exact: true }).click()
  await page.getByLabel('评论内容').fill('评论流程正常')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.comment')).toContainText('评论流程正常')
  await page.getByRole('button', { name: '更多操作' }).first().click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
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
  }
  await page.goto('/#/settings')
  await page.locator('label.theme-option').filter({ hasText: '深色' }).click()
  await expect(page.getByRole('radio', { name: '深色', exact: true })).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('link', { name: '编辑资料' }).click()
  await page.getByRole('button', { name: '返回设置' }).click()
  await expect(page).toHaveURL(/#\/settings$/)
  await page.setViewportSize({ width: 390, height: 844 })
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
  await expect(page.locator('.journal-heading h1')).toContainText('一起')
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
  await page.getByRole('button', { name: '播放视频' }).first().click()
  await expect(page.locator('.is-playing')).toBeVisible()
  await page.locator('.site-title').click()
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
