import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTab, deleteHost, ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

// Opens the dual-pane SFTP browser for a freshly-saved host and returns its Remote region -
// every case here drives the *remote* pane specifically, since that's a real SFTP round-trip
// to the openssh-server container (the file ops actually happen on the server's filesystem).
async function openRemotePane(page: Page, hostName: string): Promise<Locator> {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', hostName)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText(hostName)).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: `SFTP to ${hostName}` }).click()
  const remote = page.getByRole('region', { name: 'Remote', exact: true })
  await expect(remote).toBeVisible({ timeout: 10_000 })
  // ".ssh" is always present in the test image's home dir - waiting on it confirms the
  // remote listing has actually loaded before we start creating/renaming/deleting.
  await expect(remote.getByText('.ssh', { exact: true })).toBeVisible({ timeout: 10_000 })
  return remote
}

// Creates a remote folder via the pane's "New folder" header button (which opens the in-DOM
// NamePrompt, not a browser dialog) and waits for it to show up in the listing.
async function makeRemoteFolder(page: Page, remote: Locator, name: string) {
  await remote.getByRole('button', { name: /New folder/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(remote.getByText(name, { exact: true })).toBeVisible({ timeout: 10_000 })
}

test('right-click a remote entry to rename it', async ({ page }) => {
  const remote = await openRemotePane(page, 'rename test host')
  const original = `e2e-rename-${Date.now()}`
  const renamed = `${original}-renamed`

  await makeRemoteFolder(page, remote, original)

  await remote.getByText(original, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('Name', { exact: true }).fill(renamed)
  await page.getByRole('button', { name: 'Rename', exact: true }).click()

  await expect(remote.getByText(renamed, { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(remote.getByText(original, { exact: true })).not.toBeVisible()

  // Clean up the folder we created, then the host.
  await remote.getByText(renamed, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(remote.getByText(renamed, { exact: true })).not.toBeVisible({ timeout: 10_000 })

  await closeTab(page, 'rename test host (SFTP)')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'rename test host')
})

test('right-click a remote entry to delete it, confirming through the dialog', async ({ page }) => {
  const remote = await openRemotePane(page, 'delete test host')
  const folder = `e2e-delete-${Date.now()}`

  await makeRemoteFolder(page, remote, folder)

  await remote.getByText(folder, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  // The shared ConfirmDialog gates the destructive delete - cancelling leaves it in place.
  await expect(page.getByText(`Delete “${folder}”?`)).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(remote.getByText(folder, { exact: true })).not.toBeVisible({ timeout: 10_000 })

  await closeTab(page, 'delete test host (SFTP)')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'delete test host')
})

test('create a new remote folder from the pane header', async ({ page }) => {
  const remote = await openRemotePane(page, 'mkdir test host')
  const folder = `e2e-mkdir-${Date.now()}`

  await makeRemoteFolder(page, remote, folder)

  // Clean up the folder, then the host.
  await remote.getByText(folder, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(remote.getByText(folder, { exact: true })).not.toBeVisible({ timeout: 10_000 })

  await closeTab(page, 'mkdir test host (SFTP)')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'mkdir test host')
})

test('Ctrl+click multi-selects two remote entries and bulk-deletes them', async ({ page }) => {
  const remote = await openRemotePane(page, 'bulk delete test host')
  const stamp = Date.now()
  const first = `e2e-bulk-a-${stamp}`
  const second = `e2e-bulk-b-${stamp}`

  await makeRemoteFolder(page, remote, first)
  await makeRemoteFolder(page, remote, second)

  // Ctrl+click is a pure selection gesture (a plain click on a folder would navigate into
  // it instead) - the first adds it to an empty selection, the second extends it to both.
  await remote.getByText(first, { exact: true }).click({ modifiers: ['Control'] })
  await remote.getByText(second, { exact: true }).click({ modifiers: ['Control'] })

  // Right-clicking one of the selected entries keeps the whole selection, so the menu
  // offers the bulk delete acting on both.
  await remote.getByText(second, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete 2 items' }).click()
  await expect(page.getByText('Delete 2 items?')).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(remote.getByText(first, { exact: true })).not.toBeVisible({ timeout: 10_000 })
  await expect(remote.getByText(second, { exact: true })).not.toBeVisible({ timeout: 10_000 })

  await closeTab(page, 'bulk delete test host (SFTP)')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'bulk delete test host')
})
