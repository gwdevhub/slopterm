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
