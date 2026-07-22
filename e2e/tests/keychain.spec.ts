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
}

const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nplaywright-fake-key-data\n-----END OPENSSH PRIVATE KEY-----'

test('saves a key in the Keychain and reuses it from the shared connection form', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Keychain')
  await ensureVaultUnlocked(page)

  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })

  await page.fill('input[placeholder=Name]', 'e2e laptop key')
  await page.fill('#keychain-private-key', FAKE_KEY)
  await page.click('button:has-text("Save key")')
  await expect(page.getByText('e2e laptop key')).toBeVisible({ timeout: 10_000 })

  // Reuse it from Quick Connect, which shares ConnectionForm with the "new host" form.
  await gotoSection(page, 'Quick Connect')
  await page.getByRole('radio', { name: 'Private key' }).check()
  await page.selectOption('#keychainEntry', { label: 'e2e laptop key' })
  await expect(page.locator('#privateKey')).toHaveValue(FAKE_KEY)

  await gotoSection(page, 'Keychain')
  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })
})

test('browses a key file and can opt in to saving it to the Keychain', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await page.getByRole('radio', { name: 'Private key' }).check()

  // Bypass the native file picker (Playwright can't drive OS dialogs) by setting the
  // file directly on the hidden <input type=file> the "Browse…" button triggers.
  await page.locator('input[type=file]').setInputFiles({
    name: 'id_ed25519',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(FAKE_KEY),
  })
  await expect(page.locator('#privateKey')).toHaveValue(FAKE_KEY)

  await page.getByLabel('Save this key to Keychain for reuse').check()
  await page.fill('input[placeholder="Key name"]', 'e2e browsed key')

  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.click('button[type=submit]')

  // The test sshd is password-only, so this fake key is expected to fail the actual SSH
  // handshake - what this test cares about is that the opt-in Keychain save fired before
  // that connect attempt, not that the connection itself succeeds.
  await expect(page.locator('p.text-red-300')).toBeVisible({ timeout: 15_000 })

  await gotoSection(page, 'Keychain')
  await expect(page.getByText('e2e browsed key')).toBeVisible({ timeout: 10_000 })
  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })
})
