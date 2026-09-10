import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// Named "zz-" so it runs after every other test file: reset/import replace the entire
// shared vault wholesale, which would break other files if it ran earlier.
test('master password is disabled by default, and Settings can export/import/reset the vault', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  // Confirms the ambient default actually held for the whole suite run - no other test
  // file leaves protection enabled (settings.spec.ts explicitly restores it to off).
  const settings = await page.evaluate(() => fetch('/api/settings').then((r) => r.json()))
  expect(settings.requireMasterPassword).toBe(false)

  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.fill('#name', 'backup-e2e-host')
  await page.fill('#host', '10.9.9.9')
  await page.fill('#username', 'backupuser')
  await page.fill('#password', 'backup-pw')
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('backup-e2e-host')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Settings')
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export backup")')])
  const backupPath = await download.path()
  expect(backupPath).toBeTruthy()

  // Reset opens a ConfirmDialog; only the confirm click triggers the request and the reload,
  // so only that click races waitForEvent('load').
  await page.click('button:has-text("Reset everything to default")')
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reset', exact: true }).click()])

  await gotoSection(page, 'Settings')
  await expect(page.getByRole('button', { name: 'Disabled' })).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })

  // Import the backup taken before the reset; reloads via the ConfirmDialog's confirm click,
  // not the file-picker step.
  await gotoSection(page, 'Settings')
  await page.setInputFiles('input[type=file]', backupPath!)
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Import', exact: true }).click()])

  await gotoSection(page, 'Hosts')
  await expect(page.getByText('backup-e2e-host')).toBeVisible({ timeout: 10_000 })

  // Leave the shared vault in the pristine default state for anyone re-running the suite.
  await gotoSection(page, 'Settings')
  await page.click('button:has-text("Reset everything to default")')
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reset', exact: true }).click()])

  await gotoSection(page, 'Settings')
  await expect(page.getByRole('button', { name: 'Disabled' })).toBeVisible({ timeout: 10_000 })
})
