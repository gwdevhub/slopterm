import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { baseUrl } = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf8')) as { baseUrl: string }

for (const nativeFrame of [true, false]) {
  test(`native window with ${nativeFrame ? 'system' : 'custom'} title bar keeps navigation accessible`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'external', {
        value: { sendMessage() {}, receiveMessage() {} },
        configurable: true,
      })
    })
    await page.goto(baseUrl + (nativeFrame ? '#nativeFrame=1' : ''))

    if (nativeFrame) {
      // The initial authentication redirect must preserve the frame hint, including on reload.
      await expect(page).toHaveURL(/\/#nativeFrame=1$/)
      await page.reload()
      await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    } else {
      await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Menu', exact: true }).click()
      await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible()
    }
  })
}

test('a browser URL cannot enable native window controls', async ({ page }) => {
  await page.goto(baseUrl + '#nativeFrame=1')
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toHaveCount(0)
})
