import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection, E2E_VAULT_PASSWORD } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

test('toggling "require master password" off and back on re-keys the vault correctly', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await gotoSection(page, 'Settings')
  await expect(page.getByRole('button', { name: 'Enabled' })).toBeVisible({ timeout: 10_000 })

  // Wrong current password must be rejected and leave protection enabled.
  await page.click('button:has-text("Enabled")')
  await page.fill('#settings-password', 'not-the-real-password')
  await page.click('button:has-text("Disable")')
  await expect(page.getByText('Incorrect master password.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Enabled' })).toBeVisible()

  // Correct password disables it.
  await page.fill('#settings-password', E2E_VAULT_PASSWORD)
  await page.click('button:has-text("Disable")')
  await expect(page.getByRole('button', { name: 'Disabled' })).toBeVisible({ timeout: 10_000 })

  // The old password must no longer unlock the vault (it was re-keyed to the fixed
  // no-password seed) - checked directly against the API rather than via a UI reload,
  // since there's currently no "lock" affordance in the UI to force re-triggering the
  // unlock screen mid-session.
  const oldPasswordStillWorks = await page.evaluate(async (pw) => {
    const res = await fetch('/api/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: pw }),
    })
    return res.ok
  }, E2E_VAULT_PASSWORD)
  expect(oldPasswordStillWorks).toBe(false)

  // Re-enable with a new password.
  await page.click('button:has-text("Disabled")')
  const newPassword = 'a-brand-new-e2e-password'
  await page.fill('#settings-password', newPassword)
  await page.click('button:has-text("Enable")')
  await expect(page.getByRole('button', { name: 'Enabled' })).toBeVisible({ timeout: 10_000 })

  // The new password must now actually unlock the vault.
  const newPasswordWorks = await page.evaluate(async (pw) => {
    const res = await fetch('/api/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: pw }),
    })
    return res.ok
  }, newPassword)
  expect(newPasswordWorks).toBe(true)

  // Restore the shared master password - every e2e test file uses the same server/vault
  // for the whole suite run (see vault-helpers.ts), so leaving it on newPassword would
  // break any test file that runs after this one.
  await page.evaluate(
    async ([current, restored]) => {
      await fetch('/api/settings/require-master-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: false, currentPassword: current }),
      })
      await fetch('/api/settings/require-master-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: true, newPassword: restored }),
      })
    },
    [newPassword, E2E_VAULT_PASSWORD],
  )
})
