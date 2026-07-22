import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTab, ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

test('quick-connects via the modal, then reconnects from Recent without retyping the password', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("Quick connect")')
  await expect(page.getByRole('heading', { name: 'Quick connect' })).toBeVisible()
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  // Exact match matters: a plain :has-text("Connect")/has-text selector also matches the
  // "Quick connect" trigger button itself (substring, case-insensitive), which is still
  // present (just visually behind the modal overlay).
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)

  // Closing the last tab drops back to the currently-selected section (Hosts) - the
  // connection just made should now show up in Recent, snapped to the bottom of the
  // screen below the host grid, rendered with the same card layout as a saved host.
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible({ timeout: 10_000 })
  const recentSummary = `${ctx.sshUsername}@${ctx.sshHost}:${ctx.sshPort}`
  await expect(page.getByText(recentSummary)).toBeVisible()

  // The whole point of RecentConnectionRecord retaining the credential: reconnecting via
  // the card's SSH button must not require retyping the password.
  await page.getByRole('button', { name: `SSH to ${ctx.sshHost}` }).click()
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
})
