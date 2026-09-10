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

test('saves a key in the Keychain and reuses it from the shared connection form by name', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Keychain')
  await ensureVaultUnlocked(page)

  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })

  await page.click('button:has-text("New key")')
  await page.fill('input[placeholder=Name]', 'e2e laptop key')
  await page.fill('#keychain-private-key', FAKE_KEY)
  await page.click('button:has-text("Save key")')
  await expect(page.getByText('e2e laptop key')).toBeVisible({ timeout: 10_000 })

  // The card says a key is stored without ever showing it - the listing endpoint carries
  // names and "has a key" flags, never key material.
  await expect(page.getByText('Stored, not shown')).toBeVisible()

  // The "new host" form shares ConnectionForm with Quick Connect; a host NAMES a key rather
  // than copying it, so it resolves to whatever key each device holds under that name.
  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.getByRole('radio', { name: 'Use a key named…' }).check()
  await expect(page.locator('#namedKey')).toBeVisible()
  await expect(page.locator('#keychain-names option[value="e2e laptop key"]')).toHaveCount(1)

  // No private-key textarea in this mode at all: there is nothing for the form to hold.
  await expect(page.locator('#privateKey')).toHaveCount(0)

  // The "new host" form is a real modal now (HostModal) that blocks navigating elsewhere
  // until closed, so abandoning it (never saving a host here) needs an explicit Escape first.
  await page.keyboard.press('Escape')
  await gotoSection(page, 'Keychain')
  await page.click('button:has-text("Delete")')
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })
})

test('a keychain entry is edited by replacement, never by revealing the key', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Keychain')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New key")')
  await page.fill('input[placeholder=Name]', 'edit test key')
  await page.fill('#keychain-private-key', FAKE_KEY)
  await page.fill('input[placeholder="Passphrase (optional)"]', 'original-passphrase')
  await page.click('button:has-text("Save key")')
  await expect(page.getByText('edit test key')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Stored, not shown · passphrase set')).toBeVisible()

  // Edit shows only the NAME; key and passphrase are deliberately empty with a "stored"
  // placeholder - a guardrail against casual copying, not a claim of inaccessibility.
  await page.click('button:has-text("Edit")')
  await expect(page.locator('input[placeholder=Name]')).toHaveValue('edit test key')
  await expect(page.locator('#keychain-private-key')).toHaveValue('')
  await expect(page.locator('#keychain-private-key')).toHaveAttribute('placeholder', /Stored/)
  await expect(page.getByPlaceholder('Stored — type to replace')).toHaveValue('')

  // Cancel must discard any changes made while it was open.
  await page.fill('input[placeholder=Name]', 'edit test key SHOULD NOT SAVE')
  await page.click('button:has-text("Cancel")')
  await expect(page.getByText('edit test key', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('edit test key SHOULD NOT SAVE')).not.toBeVisible()

  // Renaming without retyping the key keeps the stored key AND passphrase - an empty field
  // means "unchanged", which is the whole point of replace-don't-reveal.
  await page.click('button:has-text("Edit")')
  await page.fill('input[placeholder=Name]', 'edit test key RENAMED')
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText('edit test key RENAMED')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Stored, not shown · passphrase set')).toBeVisible()

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

  // The form only saves to the vault, never connects (that's the card's SSH/SFTP buttons);
  // what matters here is the opt-in Keychain save firing as part of that save.
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
