import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

test('dragging a file from one SFTP pane onto the other uploads/downloads it', async ({ page }) => {
  // A real local file for the Local pane to actually show and let us drag - the server's
  // local-listing default starting directory is the OS home dir, same as this Node
  // process's, since the e2e server runs on the same machine as this test runner.
  const localFileName = `e2e-drag-${Date.now()}.txt`
  const localFilePath = join(homedir(), localFileName)
  writeFileSync(localFilePath, 'local e2e drag-and-drop content')

  try {
    await page.goto(ctx.baseUrl)
    await gotoSection(page, 'Hosts')
    await ensureVaultUnlocked(page)

    await page.click('button:has-text("New host")')
    await page.fill('#name', 'transfer test host')
    await page.fill('#host', ctx.sshHost)
    await page.fill('#port', String(ctx.sshPort))
    await page.fill('#username', ctx.sshUsername)
    await page.fill('#password', ctx.sshPassword)
    await page.click('button:has-text("Save host")')
    await expect(page.getByText('transfer test host')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'SFTP to transfer test host' }).click()

    const localRegion = page.getByRole('region', { name: 'Local' })
    const remoteRegion = page.getByRole('region', { name: 'Remote' })
    await expect(localRegion.getByText(localFileName, { exact: true })).toBeVisible({ timeout: 10_000 })

    // Local -> Remote: upload.
    await localRegion.getByText(localFileName, { exact: true }).dragTo(remoteRegion)
    await expect(page.getByText(`Uploaded ${localFileName}`)).toBeVisible({ timeout: 10_000 })
    await expect(remoteRegion.getByText(localFileName, { exact: true })).toBeVisible({ timeout: 10_000 })

    // Remote -> Local: download (back over the same path is fine - the backend always
    // overwrites, same as any real SFTP client would).
    await remoteRegion.getByText(localFileName, { exact: true }).dragTo(localRegion)
    await expect(page.getByText(`Downloaded ${localFileName}`)).toBeVisible({ timeout: 10_000 })

    await closeTab(page, 'transfer test host (SFTP)')
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'transfer test host')
  } finally {
    if (existsSync(localFilePath)) unlinkSync(localFilePath)
  }
})

test('dropping an OS file from the file manager onto the remote pane uploads it', async ({ page }) => {
  // No file on disk this time - an OS drag carries the file's *bytes* (a real File in
  // dataTransfer.files), which is the whole point of this path vs. the path-based upload.
  const osFileName = `e2e-os-drop-${Date.now()}.txt`

  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'os drop test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('os drop test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SFTP to os drop test host' }).click()

  const remoteRegion = page.getByRole('region', { name: 'Remote' })
  // Wait for the remote listing to have loaded (its ".." entry appears once connected).
  await expect(remoteRegion).toBeVisible({ timeout: 10_000 })

  // Synthesize the OS-file drop: build a DataTransfer holding a real File (so
  // dataTransfer.files/.types mirror a genuine Explorer/Finder/Nautilus drag) and dispatch
  // dragover+drop at the remote pane's list, the way FilePane's handlers expect.
  await remoteRegion.locator('ul').evaluate((list, name) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['os dragged bytes'], name, { type: 'text/plain' }))
    for (const type of ['dragover', 'drop'] as const) {
      list.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
  }, osFileName)

  await expect(page.getByText(`Uploaded ${osFileName}`)).toBeVisible({ timeout: 10_000 })
  await expect(remoteRegion.getByText(osFileName, { exact: true })).toBeVisible({ timeout: 10_000 })

  await closeTab(page, 'os drop test host (SFTP)')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'os drop test host')
})
