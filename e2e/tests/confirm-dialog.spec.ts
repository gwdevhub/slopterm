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

test('closing a tab asks for confirmation - Escape cancels, Enter confirms', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'confirm dialog test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('confirm dialog test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SSH to confirm dialog test host' }).click()
  await expect(page.locator('.xterm-rows')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })

  const closeButton = page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` })
  const dialogHeading = page.getByRole('heading', { name: 'Close this session?' })

  // Escape cancels - the tab (and its terminal) must still be there afterward.
  await closeButton.click()
  await expect(dialogHeading).toBeVisible({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await expect(dialogHeading).not.toBeVisible()
  await expect(closeButton).toBeVisible()

  // Enter confirms - the tab actually closes.
  await closeButton.click()
  await expect(dialogHeading).toBeVisible({ timeout: 5_000 })
  await page.keyboard.press('Enter')
  await expect(dialogHeading).not.toBeVisible()
  await expect(closeButton).not.toBeVisible()

  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'confirm dialog test host')
})
