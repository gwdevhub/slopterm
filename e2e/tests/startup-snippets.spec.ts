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

function terminalText(page: import('@playwright/test').Page) {
  return page.locator('.xterm-rows:visible').innerText()
}

test('a host can run its attached startup snippets automatically right after connecting', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  // One snippet attached at host-creation time (ConnectionForm's checklist), one attached
  // later to the already-saved host via the edit modal (same checklist, reused) - covers
  // both places a snippet can be attached.
  await gotoSection(page, 'Snippets')
  await ensureVaultUnlocked(page)
  const markerA = `startupmarkerA${Date.now()}`
  const markerB = `startupmarkerB${Date.now()}`
  await page.click('button:has-text("New snippet")')
  await page.fill('input[placeholder=Name]', 'startup snippet A')
  await page.fill('textarea[placeholder=Command]', `echo ${markerA}`)
  await page.click('button:has-text("Save snippet")')
  await expect(page.getByText('startup snippet A')).toBeVisible({ timeout: 10_000 })
  await page.click('button:has-text("New snippet")')
  await page.fill('input[placeholder=Name]', 'startup snippet B')
  await page.fill('textarea[placeholder=Command]', `echo ${markerB}`)
  await page.click('button:has-text("Save snippet")')
  await expect(page.getByText('startup snippet B')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.fill('#name', 'startup snippet test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.getByLabel('startup snippet A').check()
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('startup snippet test host')).toBeVisible({ timeout: 10_000 })

  // Attach the second snippet to the now-saved host via its edit modal (the card's pencil
  // icon), then save.
  await page.getByRole('button', { name: 'Edit startup snippet test host' }).click()
  await page.getByLabel('startup snippet B').check()
  await page.click('button:has-text("Save changes")')
  await expect(page.getByText('startup snippet test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SSH to startup snippet test host' }).click()
  await expect(async () => {
    const text = await terminalText(page)
    expect(text).toContain(markerA)
    expect(text).toContain(markerB)
  }).toPass({ timeout: 20_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)

  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'startup snippet test host')

  await gotoSection(page, 'Snippets')
  await page.getByRole('listitem').filter({ hasText: 'startup snippet A' }).getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('listitem').filter({ hasText: 'startup snippet B' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('No saved snippets yet.')).toBeVisible({ timeout: 10_000 })
})
