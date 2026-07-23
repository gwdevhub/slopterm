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

test('creates a vault, saves a host, connects to it, and deletes it', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'e2e test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')

  await expect(page.getByText('e2e test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SSH to e2e test host' }).click()
  await expect(async () => {
    expect(await page.locator('.xterm-rows').innerText()).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'e2e test host')
  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })
})
