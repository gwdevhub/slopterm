import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deleteHost, ensureVaultUnlocked, gotoSection } from './vault-helpers'

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

test('connects over SSH and closes its tab when the remote shell exits', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'connect test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('connect test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SSH to connect test host' }).click()

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

  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` })).toHaveCount(0, {
    timeout: 10_000,
  })

  // Clean up - other spec files assert "No saved hosts yet." against this same shared
  // vault, so anything created here must not leak past this test.
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'connect test host')
})

test('shows an error message for a bad password instead of hanging', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'bad password test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', 'definitely-the-wrong-password')
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('bad password test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SSH to bad password test host' }).click()

  await expect(page.getByText(/failed|denied|authentication/i)).toBeVisible({ timeout: 15_000 })
  // Should stay on the Hosts screen, not silently switch to a terminal tab.
  await expect(page.locator('button:has-text("New host")')).toBeVisible()

  await deleteHost(page, 'bad password test host')
})
