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

test('shows a recent connection on the Hosts screen and reconnects to it', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  // A saved host to connect through - the ad hoc "type and connect without saving" form
  // no longer exists (that was the old Quick Connect page), every connection now goes
  // through a saved Host's "SSH" button.
  await page.click('button:has-text("New host")')
  await page.fill('#name', 'recent test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('recent test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: `SSH to recent test host` }).click()
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
  await page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` }).click()

  // Closing the last tab drops back to the currently-selected section (Hosts), so the
  // just-made connection should now show up in the Recent list above the host grid.
  const recentLabel = `${ctx.sshUsername}@${ctx.sshHost}:${ctx.sshPort}`
  await expect(page.getByText(recentLabel)).toBeVisible({ timeout: 10_000 })

  await page.getByText(recentLabel).click()
  await expect(page.locator('#host')).toHaveValue(ctx.sshHost)
  await expect(page.locator('#port')).toHaveValue(String(ctx.sshPort))
  await expect(page.locator('#username')).toHaveValue(ctx.sshUsername)

  // The recent-reconnect form isn't tied to the saved host - it doesn't know a password,
  // so filling one in and submitting connects directly without ever touching the vault.
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Connect")')
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
  await page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` }).click()

  await gotoSection(page, 'Hosts')
  await page.click('text=recent test host')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
})
