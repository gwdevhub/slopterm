import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

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
  await expect(cardButton.getByText(`${ctx.sshUsername}@${ctx.sshHost}`, { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(cardButton.getByText('Password', { exact: true })).toBeVisible()

  await cardButton.dblclick()
  await expect(page.locator('.xterm-rows')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })

  await page.getByRole('button', { name: `Close ${ctx.sshUsername}@${ctx.sshHost}` }).click()
  await gotoSection(page, 'Hosts')
  await page.click('text=card summary test host')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
})
