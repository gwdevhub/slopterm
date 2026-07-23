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

test('a host card shows user@host and its auth method at a glance, and double-clicking connects', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'card summary test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')

  // Exact match matters: "SSH to card summary test host"/"SFTP to card summary test
  // host" both contain this card's name as a substring too.
  const cardButton = page.getByRole('button', { name: /^card summary test host/ })
  // The port only joins the summary when it's non-default (see HostGrid.tsx) - the e2e
  // SSH container's port is always a random non-22 one, so it's expected here too.
  const summary = ctx.sshPort === 22 ? `${ctx.sshUsername}@${ctx.sshHost}` : `${ctx.sshUsername}@${ctx.sshHost}:${ctx.sshPort}`
  await expect(cardButton.getByText(summary, { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(cardButton.getByText('Password', { exact: true })).toBeVisible()

  await cardButton.dblclick()
  await expect(page.locator('.xterm-rows')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'card summary test host')
})
