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

test('a host card\'s edit icon opens a modal to rename, duplicate, and delete (with confirmation)', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'edit modal test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('edit modal test host')).toBeVisible({ timeout: 10_000 })

  // There's no more side panel - only the card's own pencil icon (and the right-click
  // context menu's "Edit") reach the host's editable details now.
  await page.getByRole('button', { name: 'Edit edit modal test host' }).click()
  await expect(page.getByRole('heading', { name: 'Edit host' })).toBeVisible()
  await expect(page.locator('#name')).toHaveValue('edit modal test host')
  await expect(page.locator('#host')).toHaveValue(ctx.sshHost)

  // Cancel discards - renaming and hitting Cancel must not persist.
  await page.fill('#name', 'edit modal test host RENAMED')
  await page.click('button:has-text("Cancel")')
  await expect(page.getByText('edit modal test host', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('edit modal test host RENAMED')).not.toBeVisible()

  // Save changes does persist.
  await page.getByRole('button', { name: 'Edit edit modal test host' }).click()
  await page.fill('#name', 'edit modal test host RENAMED')
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText('edit modal test host RENAMED')).toBeVisible({ timeout: 10_000 })

  // Duplicate creates an independent copy and re-opens the modal for it, ready to adjust.
  await page.getByRole('button', { name: 'Edit edit modal test host RENAMED' }).click()
  await page.click('button:has-text("Duplicate")')
  await expect(page.locator('#name')).toHaveValue('edit modal test host RENAMED (copy)', { timeout: 10_000 })
  await page.fill('#name', 'edit modal test host COPY')
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText('edit modal test host RENAMED', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('edit modal test host COPY')).toBeVisible()

  // Delete asks for confirmation - Escape cancels it (and the host survives).
  await page.getByRole('button', { name: 'Edit edit modal test host COPY' }).click()
  await page.getByRole('button', { name: 'Delete host' }).click()
  await expect(page.getByRole('heading', { name: 'Delete this host?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Delete this host?' })).not.toBeVisible()
  await page.click('button:has-text("Cancel")')
  await expect(page.getByText('edit modal test host COPY')).toBeVisible({ timeout: 10_000 })

  // Confirming actually deletes it.
  await page.getByRole('button', { name: 'Edit edit modal test host COPY' }).click()
  await page.getByRole('button', { name: 'Delete host' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('edit modal test host COPY')).not.toBeVisible({ timeout: 10_000 })

  // Clean up the original (renamed) host too.
  await page.getByRole('button', { name: 'Edit edit modal test host RENAMED' }).click()
  await page.getByRole('button', { name: 'Delete host' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })
})
