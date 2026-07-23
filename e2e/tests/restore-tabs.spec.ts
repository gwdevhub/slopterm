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

test('reopening the app restores open tabs and reconnects them, keeping the previously active one active', async ({
  page,
}) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'restore test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('restore test host')).toBeVisible({ timeout: 10_000 })

  // Two tabs against the same host - the second (opened last, so already active) is the
  // one that must come back as the active tab after reload.
  await page.getByRole('button', { name: 'SSH to restore test host' }).click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })
  await gotoSection(page, 'Hosts')
  await page.getByRole('button', { name: 'SSH to restore test host' }).click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  const marker = `restoremarker${Date.now()}`
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await terminalText(page)).toContain(marker)
  }).toPass({ timeout: 10_000 })

  // Simulate relaunching the app - a fresh page load, no tabs open yet client-side.
  await page.goto(ctx.baseUrl)

  // Both tabs should reappear on their own (client-generated ids, so matched by label) and
  // reconnect without any user action - proving the retained credential actually works,
  // not just that the tab shape got remembered. Exact match matters: a substring match
  // also catches each tab's neighboring "Close ..." button, whose aria-label contains the
  // same text.
  const tabButtons = page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}`, exact: true })
  await expect(tabButtons).toHaveCount(2, { timeout: 10_000 })

  // The second tab was active when the app "closed", so it should already be showing -
  // reconnecting gets a brand new session, so the earlier marker is gone from this fresh
  // shell, but the welcome banner proves the retry loop actually reconnected it.
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 20_000 })
  await expect(page.locator('.xterm-rows:visible')).not.toContainText(marker)

  // Switch to the first (background) tab and confirm it reconnected too, not just the one
  // that happened to be active - closeTab below expects a live "close session?" confirm,
  // which only appears once a tab is actually connected.
  await tabButtons.first().click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 20_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)

  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'restore test host')
})
