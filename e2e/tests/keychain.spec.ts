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

  // Reuse it from the "new host" form, which shares ConnectionForm with the Quick
  // Connect modal (a third caller, triggered from the Hosts screen's own button).
  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.getByRole('radio', { name: 'Private key' }).check()
  await page.selectOption('#keychainEntry', { label: 'e2e laptop key' })
  await expect(page.locator('#privateKey')).toHaveValue(FAKE_KEY)

  // The "new host" form is a real modal now (HostModal), unlike the old inline side
  // panel - it covers the whole page and blocks navigating elsewhere until closed, so
  // abandoning it (never actually saving a host here) needs an explicit Escape first.
  await page.keyboard.press('Escape')
  await gotoSection(page, 'Keychain')
  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })
})

test('a keychain entry can be edited in place, and Cancel discards unsaved changes', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Keychain')
  await ensureVaultUnlocked(page)

  await page.fill('input[placeholder=Name]', 'edit test key')
  await page.fill('#keychain-private-key', FAKE_KEY)
  await page.fill('input[placeholder="Passphrase (optional)"]', 'original-passphrase')
  await page.click('button:has-text("Save key")')
  await expect(page.getByText('edit test key')).toBeVisible({ timeout: 10_000 })

  // Edit pre-fills the real key/passphrase (listKeychainEntries already returns them in
  // full - ConnectionForm's own "use a saved key" dropdown already relies on that), not
  // just the name. Cancel must discard any changes made while it was open.
  await page.click('button:has-text("Edit")')
  await expect(page.locator('#keychain-private-key')).toHaveValue(FAKE_KEY)
  await expect(page.locator('input[placeholder="Passphrase (optional)"]')).toHaveValue('original-passphrase')
  await page.fill('input[placeholder=Name]', 'edit test key SHOULD NOT SAVE')
  await page.click('button:has-text("Cancel")')
  await expect(page.getByText('edit test key', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('edit test key SHOULD NOT SAVE')).not.toBeVisible()

  // Save changes does persist.
  await page.click('button:has-text("Edit")')
  await page.fill('input[placeholder=Name]', 'edit test key RENAMED')
  await page.fill('input[placeholder="Passphrase (optional)"]', 'new-passphrase')
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText('edit test key RENAMED')).toBeVisible({ timeout: 10_000 })

  await page.click('button:has-text("Edit")')
  await expect(page.locator('input[placeholder="Passphrase (optional)"]')).toHaveValue('new-passphrase')
  await page.click('button:has-text("Cancel")')

  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })
})

test('browses a key file and can opt in to saving it to the Keychain', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await page.click('button:has-text("New host")')
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

  // The "new host" form only ever saves to the vault - it never attempts a connection
  // itself (that's a deliberate separate step, the card's own "SSH"/"SFTP" buttons) - so
  // what this test cares about is that the opt-in Keychain save fires as part of that
  // save, not that any connection happens.
  await page.fill('#name', 'e2e key browse host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('e2e key browse host')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Keychain')
  await expect(page.getByText('e2e browsed key')).toBeVisible({ timeout: 10_000 })
  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'e2e key browse host')
})
