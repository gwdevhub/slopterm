import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

test('shows a recent connection on Quick Connect and reconnects to it', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  // Unlock the vault first - AppendLog is a no-op while locked, so the connect below
  // wouldn't otherwise leave a "connected" entry for Recents to pick up.
  await gotoSection(page, 'Logs')
  await ensureVaultUnlocked(page)

  await gotoSection(page, 'Quick Connect')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button[type=submit]')
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
  await page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` }).click()

  // Closing the last tab remounts AppShell fresh (back on Quick Connect by default), so
  // the just-made connection should now show up as a recent.
  const recentLabel = `${ctx.sshUsername}@${ctx.sshHost}:${ctx.sshPort}`
  await expect(page.getByText(recentLabel)).toBeVisible({ timeout: 10_000 })

  await page.fill('#host', 'should-be-overwritten.example')
  await page.getByText(recentLabel).click()

  await expect(page.locator('#host')).toHaveValue(ctx.sshHost)
  await expect(page.locator('#port')).toHaveValue(String(ctx.sshPort))
  await expect(page.locator('#username')).toHaveValue(ctx.sshUsername)
})
