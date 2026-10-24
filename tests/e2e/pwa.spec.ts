import { test, expect } from '@playwright/test'

test.afterEach(async ({ request }) => {
  await request.post('/__test/sw', { data: { version: 'current' } })
})

test('v21 升级等待确认、旧标签页资源保留、失败安装不接管', async ({ page, context, request }) => {
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
  await page.goto('/#/login')
  await expect(page.getByRole('button', { name: '更新并重新加载' })).toBeVisible()
  expect(
    await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)),
  ).toBe(true)
  await page.getByRole('button', { name: '更新并重新加载' }).click()
  await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
  await expect(page.locator('.update-prompt')).toHaveCount(0)
  expect(await oldTab.evaluate(async () => (await fetch('/app.js')).text())).toContain('legacy = true')
  expect(await oldTab.evaluate(async () => (await fetch('/js/legacy.js')).text())).toContain(
    'legacyModule = true',
  )
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
  const otherApp = await context.newPage()
  await otherApp.goto('/#/login')
  await otherApp.evaluate(() => {
    document.documentElement.dataset.originalDocument = 'yes'
  })
  await request.post('/__test/sw', { data: { version: 'next' } })
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update()
  })
  await expect(page.getByRole('button', { name: '更新并重新加载' })).toBeVisible()
  await expect(otherApp.getByRole('button', { name: '更新并重新加载' })).toBeVisible()
  await page.getByLabel('登录账号', { exact: true }).fill('user1')
  await page.getByLabel('密码', { exact: true }).fill('pass1')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.journal-heading-actions button').click()
  await page.getByLabel('动态正文').fill('升级前的草稿')
  await expect(page.locator('.update-prompt button')).toBeDisabled()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.composer-overlay')).toHaveCount(0)
  await page.getByRole('button', { name: '更新并重新加载' }).click()
  await page.locator('.journal-heading-actions button').click()
  await expect(page.getByLabel('动态正文')).toHaveValue('升级前的草稿')
  await expect(otherApp.locator('.update-prompt')).toHaveCount(0)
  await expect(otherApp.locator('html')).toHaveAttribute('data-original-document', 'yes')
  expect(await oldTab.evaluate(async () => (await fetch('/app.js')).text())).toContain('legacy = true')
  await otherApp.close()
  await oldTab.close()
})
