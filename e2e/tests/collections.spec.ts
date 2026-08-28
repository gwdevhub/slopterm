import { test, expect, type Page } from '@playwright/test'
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

// Deliberately unreachable: these tests are about the collection lifecycle in the UI - create,
// invite, join, leave - not about whether WebDAV works. The sync loop's failure to reach this
// is expected and surfaces as the card's error line, which is itself worth seeing.
const UNREACHABLE_WEBDAV = 'https://127.0.0.1:9/dav'

async function removeAllCollections(page: Page) {
  await gotoSection(page, 'Collections')
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const leave = page.getByRole('button', { name: 'Leave' }).first()
    if (!(await leave.isVisible().catch(() => false))) return
    await leave.click()
    // Don't keep the records: these are throwaway test collections, and leaving copies
    // behind would leak hosts into later specs.
    await page.getByLabel('Keep a copy of its hosts and snippets here').uncheck()
    await page.getByRole('button', { name: 'Leave collection' }).click()
    await expect(page.getByRole('heading', { name: /^Leave / })).not.toBeVisible({ timeout: 10_000 })
  }
}

async function createNamedKeyHost(page: Page, name: string, collection?: string) {
  await page.getByRole('button', { name: 'New host' }).click()
  await page.fill('#name', name)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.getByRole('radio', { name: 'Use a key named…' }).check()
  await page.fill('#namedKey', 'e2e-bulk-key')
  if (collection) await page.selectOption('#collection', { label: collection })
  await page.getByRole('button', { name: 'Save host' }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 10_000 })
}

test('creates a collection, copies its invite token, and leaves it again', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await removeAllCollections(page)

  await expect(page.getByText('No collections yet.', { exact: false })).toBeVisible({ timeout: 10_000 })

  await page.click('button:has-text("New collection")')
  await page.fill('#col-name', 'e2e team collection')
  await page.fill('#col-url', UNREACHABLE_WEBDAV)
  await page.fill('#col-user', 'e2e')
  await page.fill('#col-pass', 'e2e-secret')

  // Turning the keychain scope on says plainly what that means - it's the one scope where
  // "on" is a decision to hand everyone your private keys.
  await page.getByLabel('Keychain (private keys)').check()
  await expect(page.getByText('Everyone in this collection gets a copy of every private key', { exact: false })).toBeVisible()
  await page.getByLabel('Keychain (private keys)').uncheck()

  await page.click('button:has-text("Create collection")')
  await expect(page.getByText('e2e team collection')).toBeVisible({ timeout: 10_000 })

  // The invite is one line of text, hidden until asked for, with the warning that possession
  // of it IS membership.
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.getByText("This carries the collection's encryption key", { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Show token' }).click()
  await expect(page.locator('#token-value')).toHaveValue(/^slopterm:collection:v1:/, { timeout: 10_000 })
  await page.getByRole('button', { name: 'Close' }).click()

  // The whole-device dump is a different prefix and covers every collection at once - the
  // "set up my new phone in one paste" path.
  await page.getByRole('button', { name: 'Copy sync configuration…' }).click()
  await page.getByRole('button', { name: 'Show token' }).click()
  await expect(page.locator('#token-value')).toHaveValue(/^slopterm:sync-config:v1:/, { timeout: 10_000 })
  await page.getByRole('button', { name: 'Close' }).click()

  await removeAllCollections(page)
  await expect(page.getByText('No collections yet.', { exact: false })).toBeVisible({ timeout: 10_000 })
})

test('a host can be assigned to a collection and is badged as shared', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await removeAllCollections(page)

  await gotoSection(page, 'Collections')
  await page.click('button:has-text("New collection")')
  await page.fill('#col-name', 'e2e shared')
  await page.fill('#col-url', UNREACHABLE_WEBDAV)
  await page.click('button:has-text("Create collection")')
  await expect(page.getByText('e2e shared')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.fill('#name', 'e2e shared host')
  await page.selectOption('#collection', { label: 'e2e shared' })
  await expect(page.getByText('Everyone in this collection will see this host', { exact: false })).toBeVisible()

  // "Use a key named…" is what makes sharing a host actually useful: the host travels, the
  // key doesn't - each device resolves the name against a key it holds itself.
  await page.getByRole('radio', { name: 'Use a key named…' }).check()
  await expect(page.getByText('This host carries no key', { exact: false })).toBeVisible()
  await page.fill('#namedKey', 'e2e-nonexistent-key')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.click('button:has-text("Save host")')

  await expect(page.getByText('e2e shared host')).toBeVisible({ timeout: 10_000 })

  // Nothing on this device resolves that name, so the card says so and refuses to connect
  // rather than silently reaching for some other key.
  await expect(page.getByText('no key called "e2e-nonexistent-key" on this device')).toBeVisible()
  await expect(page.getByRole('button', { name: 'SSH to e2e shared host' })).toBeDisabled()

  await deleteHost(page, 'e2e shared host')
  await removeAllCollections(page)
})

test('multiple hosts can be moved to a collection and deleted together', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await removeAllCollections(page)

  await page.getByRole('button', { name: 'New collection' }).click()
  await page.fill('#col-name', 'e2e bulk collection')
  await page.fill('#col-url', UNREACHABLE_WEBDAV)
  await page.getByRole('button', { name: 'Create collection' }).click()
  await expect(page.getByText('e2e bulk collection')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await createNamedKeyHost(page, 'e2e bulk local one')
  await createNamedKeyHost(page, 'e2e bulk local two')
  await createNamedKeyHost(page, 'e2e bulk already shared', 'e2e bulk collection')

  let moveRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/vault\/records\/hosts\/[^/]+\/collection$/.test(request.url())) {
      moveRequests++
    }
  })

  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByLabel('Select e2e bulk local one').check()
  await page.getByLabel('Select e2e bulk local two').check()
  await page.getByLabel('Select e2e bulk already shared').check()
  await page.getByLabel('Destination collection').selectOption({ label: 'e2e bulk collection' })
  await page.getByRole('button', { name: 'Move', exact: true }).click()

  await expect(page.getByText('Moved 2 hosts to e2e bulk collection; skipped 1 already there')).toBeVisible()
  await expect(page.locator('[title="Shared through e2e bulk collection"]')).toHaveCount(3)
  expect(moveRequests).toBe(2)

  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByLabel('Select e2e bulk local one').check()
  await page.getByLabel('Select e2e bulk local two').check()
  await page.getByLabel('Select e2e bulk already shared').check()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Delete selected hosts?' })).toBeVisible()
  await page.getByRole('button', { name: 'Delete hosts' }).click()

  await expect(page.getByText('e2e bulk local one', { exact: true })).not.toBeVisible()
  await expect(page.getByText('e2e bulk local two', { exact: true })).not.toBeVisible()
  await expect(page.getByText('e2e bulk already shared', { exact: true })).not.toBeVisible()
  await removeAllCollections(page)
})

test('lists what a collection actually carries', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await removeAllCollections(page)

  await gotoSection(page, 'Collections')
  await page.click('button:has-text("New collection")')
  await page.fill('#col-name', 'e2e contents')
  await page.fill('#col-url', UNREACHABLE_WEBDAV)
  await page.click('button:has-text("Create collection")')
  await expect(page.getByText('e2e contents')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.fill('#name', 'e2e listed host')
  await page.selectOption('#collection', { label: 'e2e contents' })
  // Deliberately NOT the real test SSH host: this record is only ever read back as a line of
  // text, and an address of its own means that if this test ever fails before its cleanup,
  // the leftover can't collide with the address other specs match on.
  await page.fill('#host', '10.99.0.1')
  await page.fill('#port', '2222')
  await page.fill('#username', 'e2e-listed')
  // The password field is `required` under the default auth method, so the form simply
  // doesn't submit without it - this host is never connected to, the value is irrelevant.
  await page.fill('#password', 'e2e-secret')
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('e2e listed host')).toBeVisible({ timeout: 10_000 })

  // The point of the view: the card's count says how many records converge, this says which.
  await gotoSection(page, 'Collections')
  // Scoped to this collection's own card. Another spec's collection can still be on screen -
  // removeAllCollections is best-effort - and "the only Contents button" is not something
  // this test needs to be true.
  const card = page.locator('li', { hasText: 'e2e contents' })
  await card.getByRole('button', { name: 'Contents' }).click()
  // Scoped to the modal: "Hosts" and the host's name both also exist behind it, on the page
  // it opened over.
  const modal = page.locator('form', { has: page.getByRole('heading', { name: 'Inside e2e contents' }) })
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await expect(modal.getByText('1 record syncing')).toBeVisible()
  await expect(modal.getByRole('heading', { name: 'Hosts', exact: true })).toBeVisible()
  await expect(modal.getByText('e2e listed host')).toBeVisible()
  // The address line is what tells two same-named hosts apart.
  await expect(modal.getByText('e2e-listed@10.99.0.1:2222')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('heading', { name: 'Inside e2e contents' })).not.toBeVisible()

  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'e2e listed host')
  await removeAllCollections(page)
})

test('rejects a token that isn\'t one of ours', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Collections')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("Join with a token…")')
  await page.fill('#join-token', 'slopterm:host:v1:not-a-collection-token')
  await page.getByRole('button', { name: 'Join', exact: true }).click()

  await expect(page.getByText("That isn't a valid slopterm collection token", { exact: false })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: 'Close' }).click()
})
