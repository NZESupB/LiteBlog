import { test, expect, type Page } from '@playwright/test'

async function mark(page: Page) {
  await page.evaluate(() => {
    document.documentElement.dataset.originalDocument = 'yes'
  })
}
async function reloaded(page: Page) {
  await expect(page.locator('html')).not.toHaveAttribute('data-original-document', 'yes')
  await expect(page.locator('.update-prompt')).toHaveCount(0)
}

test.afterEach(async ({ request }) => {
  await request.post('/__test/sw', { data: { version: 'current' } })
})

test('v21 已等待更新静默激活、多标签自动重载、草稿恢复及失败安装不接管', async ({
  page,
  context,
  request,
}) => {
  await request.post('/__test/sw', { data: { version: 'legacy' } })
  await page.goto('/__test/legacy')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
  })
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  const oldTab = await context.newPage()
  await oldTab.goto('/__test/legacy')
  await request.post('/__test/sw', { data: { version: 'current' } })
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update()
  })
  await expect
    .poll(() =>
      page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)),
    )
    .toBe(true)
  let loginDocuments = 0
  const activatedPage = page.waitForEvent('load', {
    predicate: () => ++loginDocuments === 2,
  })
  await page.goto('/#/login')
  await activatedPage
  await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
  await expect(async () => {
    expect(
      await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)),
    ).toBe(false)
  }).toPass({ timeout: 10000 })
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).some(
          (key) => key !== 'couple-blog-shell-v21' && key.startsWith('couple-blog-shell-'),
        ),
      ),
    )
    .toBe(true)
  await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
  await expect(page.locator('.update-prompt')).toHaveCount(0)
  expect(await oldTab.evaluate(async () => (await fetch('/app.js')).text())).toContain('legacy = true')
  expect(await oldTab.evaluate(async () => (await fetch('/js/legacy.js')).text())).toContain(
    'legacyModule = true',
  )

  await mark(page)
  await request.post('/__test/sw', { data: { version: 'broken' } })
  const failure = await page.evaluate(async () => {
    const registration = (await navigator.serviceWorker.getRegistration())!
    const result = new Promise<string>((resolve) =>
      registration.addEventListener(
        'updatefound',
        () => {
          const worker = registration.installing!
          worker.addEventListener('statechange', () => {
            if (worker.state === 'redundant') resolve(worker.state)
          })
        },
        { once: true },
      ),
    )
    await registration.update()
    return result
  })
  expect(failure).toBe('redundant')
  expect(
    await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)),
  ).toBe(false)
  await expect(page.locator('html')).toHaveAttribute('data-original-document', 'yes')

  await request.post('/__test/sw', { data: { version: 'current' } })
  await page.getByLabel('登录账号', { exact: true }).fill('user1')
  await page.getByLabel('密码', { exact: true }).fill('pass1')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.journal-heading-actions button').click()
  await expect(page.locator('.discard-draft')).toBeEnabled()
  await page.getByLabel('动态正文').fill('升级前的草稿')
  const otherApp = await context.newPage()
  await otherApp.goto('/#/')
  await expect(otherApp.locator('.journal-heading')).toBeVisible()
  await mark(page)
  await mark(otherApp)
  await request.post('/__test/sw', { data: { version: 'next' } })
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update()
  })
  await reloaded(page)
  await reloaded(otherApp)
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).some((key) => key.startsWith('couple-blog-shell-next-')),
      ),
    )
    .toBe(true)
  await page.locator('.journal-heading-actions button').click()
  await expect(page.getByLabel('动态正文')).toHaveValue('升级前的草稿')
  expect(await oldTab.evaluate(async () => (await fetch('/app.js')).text())).toContain('legacy = true')
  await otherApp.close()
  await oldTab.close()
})

test('首次安装不重载，缺失 chunk 同一资源只自动恢复一次', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'pwa-document-count'
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || 0) + 1))
  })
  await page.goto('/#/login')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  expect(await page.evaluate(() => sessionStorage.getItem('pwa-document-count'))).toBe('1')
  await mark(page)
  await page.evaluate(() => {
    const event = new Event('vite:preloadError', { cancelable: true })
    Object.assign(event, {
      payload: new Error('Failed to fetch dynamically imported module: /assets/missing-test.js'),
    })
    window.dispatchEvent(event)
  })
  await reloaded(page)
  await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('pwa-document-count'))).toBe('2')
  const cancelled = await page.evaluate(() => {
    const event = new Event('vite:preloadError', { cancelable: true })
    Object.assign(event, {
      payload: new Error('Failed to fetch dynamically imported module: /assets/missing-test.js'),
    })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(cancelled).toBe(false)
  expect(await page.evaluate(() => sessionStorage.getItem('pwa-document-count'))).toBe('2')
})
