import { test, expect } from '@playwright/test'
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

test('a host card\'s SFTP button opens a dual-pane browser with independent local/remote navigation', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'sftp test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('sftp test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SFTP to sftp test host' }).click()

  const localPane = page.getByRole('region', { name: 'Local', exact: true })
  const remotePane = page.getByRole('region', { name: 'Remote', exact: true })
  await expect(localPane).toBeVisible({ timeout: 10_000 })
  await expect(remotePane).toBeVisible()

  // The remote pane is a real, independent SFTP connection to the container - ".ssh" is
  // always present in the test image's home directory (sshd creates it), and asserting
  // it specifically in the Remote region (not just anywhere on the page) proves this
  // isn't the local listing duplicated - the e2e runner's own home directory may well
  // have its own unrelated ".ssh" folder too.
  await expect(remotePane.getByText('.ssh', { exact: true })).toBeVisible({ timeout: 10_000 })
  const remotePathBefore = await remotePane.locator('span.truncate.text-slate-500').innerText()

  await remotePane.getByText('.ssh', { exact: true }).click()
  await expect(async () => {
    const path = await remotePane.locator('span.truncate.text-slate-500').innerText()
    expect(path).not.toBe(remotePathBefore)
    expect(path).toContain('.ssh')
  }).toPass({ timeout: 10_000 })

  // ".." navigates back up to the original remote directory.
  await remotePane.getByText('..', { exact: true }).click()
  await expect(async () => {
    const path = await remotePane.locator('span.truncate.text-slate-500').innerText()
    expect(path).toBe(remotePathBefore)
  }).toPass({ timeout: 10_000 })

  await closeTab(page, 'sftp test host (SFTP)')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'sftp test host')
})
