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

test('saves a snippet and copies it to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Snippets')
  await ensureVaultUnlocked(page)

  await expect(page.getByText('No saved snippets yet.')).toBeVisible({ timeout: 10_000 })

  await page.fill('input[placeholder=Name]', 'disk usage')
  await page.fill('textarea[placeholder=Command]', 'df -h')
  await page.click('button:has-text("Save snippet")')

  await expect(page.getByText('disk usage')).toBeVisible({ timeout: 10_000 })
  await page.click('button:has-text("Copy")')
  await expect(page.getByText('Copied!')).toBeVisible()

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboardText).toBe('df -h')

  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved snippets yet.')).toBeVisible({ timeout: 10_000 })
})

test('records connection attempts in the logs section', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Logs')
  await ensureVaultUnlocked(page)

  // Clear first rather than assuming this is the only test creating log entries - the
  // vault/log store is shared across every e2e test file (see vault-helpers.ts).
  if (!(await page.getByText('No connection history yet.').isVisible().catch(() => false))) {
    await page.click('button:has-text("Clear logs")')
    await expect(page.getByText('No connection history yet.')).toBeVisible({ timeout: 10_000 })
  }

  // A real successful connect and a real failed one, via Quick Connect.
  await gotoSection(page, 'Quick Connect')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button[type=submit]')
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
  await page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` }).click()

  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', 'definitely-wrong')
  await page.click('button[type=submit]')
  // Scoped to the error paragraph's own styling rather than a broad text regex - the
  // static "Authentication" section label on this same form also matches a naive
  // /authentication/i search, which is an ambiguous strict-mode match in Playwright.
  await expect(page.locator('p.text-red-300')).toBeVisible({ timeout: 15_000 })

  await gotoSection(page, 'Logs')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Connect failed', { exact: true })).toBeVisible()
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible()

  await page.click('button:has-text("Clear logs")')
  await expect(page.getByText('No connection history yet.')).toBeVisible({ timeout: 10_000 })
})
