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
  await expect(page.getByText('Loading settings')).not.toBeVisible({ timeout: 10_000 })

  // Protection is off by default; enable it with the shared password first, unless a
  // previous run of this test left it Enabled, so the toggle test starts from a known state.
  if (await page.getByRole('button', { name: 'Disabled' }).isVisible().catch(() => false)) {
    await page.click('button:has-text("Disabled")')
    await page.fill('#settings-password', E2E_VAULT_PASSWORD)
    await page.click('button:has-text("Enable")')
    await expect(page.getByRole('button', { name: 'Enabled' })).toBeVisible({ timeout: 10_000 })
  }

  await page.click('button:has-text("Enabled")')
  await page.fill('#settings-password', 'not-the-real-password')
  await page.click('button:has-text("Disable")')
  await expect(page.getByText('Incorrect master password.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Enabled' })).toBeVisible()

  await page.fill('#settings-password', E2E_VAULT_PASSWORD)
  await page.click('button:has-text("Disable")')
  await expect(page.getByRole('button', { name: 'Disabled' })).toBeVisible({ timeout: 10_000 })

  // Old password must no longer unlock (vault re-keyed to the no-password seed); checked
  // via the API since there's no UI lock affordance to re-trigger the unlock screen.
  const oldPasswordStillWorks = await page.evaluate(async (pw) => {
    const res = await fetch('/api/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: pw }),
    })
    return res.ok
  }, E2E_VAULT_PASSWORD)
  expect(oldPasswordStillWorks).toBe(false)

  await page.click('button:has-text("Disabled")')
  const newPassword = 'a-brand-new-e2e-password'
  await page.fill('#settings-password', newPassword)
  await page.click('button:has-text("Enable")')
  await expect(page.getByRole('button', { name: 'Enabled' })).toBeVisible({ timeout: 10_000 })

  const newPasswordWorks = await page.evaluate(async (pw) => {
    const res = await fetch('/api/vault/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: pw }),
    })
    return res.ok
  }, newPassword)
  expect(newPasswordWorks).toBe(true)

  // Restore the shared default (protection off) - every other test file's
  // ensureVaultUnlocked() expects the no-prompt, auto-unlocked default.
  await page.evaluate(async (current) => {
    await fetch('/api/settings/require-master-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: false, currentPassword: current }),
    })
  }, newPassword)
})

test('"keep running in the tray when closed" defaults to off and toggles + persists', async ({ page }) => {
  // This setting only appears on Windows (navigator.platform.includes('Win')).
  // On non-Windows platforms, the button doesn't exist, so we check the API directly.
  const isWindows = await page.evaluate(() => navigator.platform.includes('Win'))

  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await gotoSection(page, 'Settings')
  await expect(page.getByText('Loading settings')).not.toBeVisible({ timeout: 10_000 })

  if (!isWindows) {
    const closeToTrayValue = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).closeToTray)
    expect(closeToTrayValue).toBe(false)
    return
  }

  // Identified by the button's stable aria-label (its visible text flips On/Off, so the
  // label is what stays constant across toggles).
  const toggle = page.getByRole('button', { name: 'Keep running in the tray when closed' })

  // Off by default - closing the window quits the app rather than minimizing to the tray.
  // (This assumes the default starting state; no other test file touches close-to-tray.)
  await expect(toggle).toHaveText('Off')
  const before = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).closeToTray)
  expect(before).toBe(false)

  await toggle.click()
  await expect(toggle).toHaveText('On')
  const afterOn = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).closeToTray)
  expect(afterOn).toBe(true)

  await toggle.click()
  await expect(toggle).toHaveText('Off')
  const afterOff = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).closeToTray)
  expect(afterOff).toBe(false)
})
