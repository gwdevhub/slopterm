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
  sshPassword: string
}

async function saveHost(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'New host' }).click()
  await page.fill('#name', name)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.getByRole('button', { name: 'Save host' }).click()
}

test('hosts are displayed alphabetically by name', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  const prefix = `sorting ${Date.now()}`
  const names = [`${prefix} zulu`, `${prefix} alpha`, `${prefix} mike`]
  for (const name of names) await saveHost(page, name)

  const cards = page.locator('div.grid > div').filter({ hasText: prefix })
  await expect(cards).toHaveCount(3)
  await expect(cards.locator('span.font-medium').first()).toHaveText(names[1])
  await expect(cards.locator('span.font-medium').nth(1)).toHaveText(names[2])
  await expect(cards.locator('span.font-medium').nth(2)).toHaveText(names[0])

  for (const name of names) await deleteHost(page, name)
})
