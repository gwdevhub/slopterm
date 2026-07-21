import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  await page.click('text=Saved Hosts')

  // Fresh vault dir per e2e run (see global-setup.ts), so this is always the setup flow.
  await expect(page.getByText('Create a vault master password')).toBeVisible()
  await page.fill('input[type=password]', 'e2e-test-master-password')
  await page.click('button:has-text("Create vault")')

  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })

  await page.fill('input[placeholder=Name]', 'e2e test host')
  await page.fill('input[placeholder=Address]', ctx.sshHost)
  await page.fill('input[type=number]', String(ctx.sshPort))
  await page.fill('input[placeholder=Username]', ctx.sshUsername)
  await page.fill('input[placeholder=Password]', ctx.sshPassword)
  await page.click('button:has-text("Save host")')

  await expect(page.getByText('e2e test host')).toBeVisible({ timeout: 10_000 })

  // Exact match matters here: "Quick Connect" (the tab button, always rendered) also
  // contains the substring "Connect", which a has-text() selector would ambiguously match.
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(async () => {
    expect(await page.locator('.xterm-rows').innerText()).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  await page.click('button:has-text("Disconnect")')
  await page.click('text=Saved Hosts')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })
})
