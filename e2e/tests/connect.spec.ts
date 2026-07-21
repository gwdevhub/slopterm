import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

function terminalText(page: import('@playwright/test').Page) {
  return page.locator('.xterm-rows').innerText()
}

test('connects over SSH and shows live shell output', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button[type=submit]')

  // The test image's own SSH banner is a distinctive marker that only appears if the
  // full path actually worked: browser -> WebSocket -> SSH.NET -> real sshd -> shell,
  // round-tripped back through xterm.js rendering.
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  const marker = `PLAYWRIGHT_E2E_${Date.now()}`
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')

  await expect(async () => {
    expect(await terminalText(page)).toContain(marker)
  }).toPass({ timeout: 10_000 })

  await page.click('button:has-text("Disconnect")')
  await expect(page.locator('#host')).toBeVisible()
})

test('shows an error message for a bad password instead of hanging', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', 'definitely-the-wrong-password')
  await page.click('button[type=submit]')

  await expect(page.getByText(/failed|denied|authentication/i)).toBeVisible({ timeout: 15_000 })
  // Should stay on the connect form, not silently switch to a terminal view.
  await expect(page.locator('#host')).toBeVisible()
})
