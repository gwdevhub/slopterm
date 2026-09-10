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

  // A reload is not a relaunch: SSH sessions outlive the socket, so tabs reattach with
  // scrollback replayed - the path an Android WebView takes when its renderer is reclaimed.
  await page.goto(ctx.baseUrl)

  // Both tabs reappear on their own (client-generated ids, matched by label). Exact match,
  // else a substring also catches each neighboring "Close ..." button.
  const tabButtons = page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}`, exact: true })
  await expect(tabButtons).toHaveCount(2, { timeout: 10_000 })

  // The second tab was active when the page reloaded, so it should already be showing - and
  // still showing what was typed into it, because it is the same shell, not a new one.
  await expect(async () => {
    expect(await terminalText(page)).toContain(marker)
  }).toPass({ timeout: 20_000 })

  // The relaunch proper: session ids are per-process, so every tab must redial from the
  // remembered credential; simulated by deleting the sessions from about:blank.
  const origin = new URL(ctx.baseUrl).origin
  await page.goto('about:blank')
  const live = (await (await page.request.get(`${origin}/api/ssh/sessions`)).json()) as { sessionId: string }[]
  for (const session of live) {
    await page.request.delete(`${origin}/api/ssh/session/${session.sessionId}`)
  }

  await page.goto(ctx.baseUrl)
  await expect(tabButtons).toHaveCount(2, { timeout: 10_000 })

  // Reconnected, not reattached: the banner proves the retry dialed with the retained
  // credential, and the missing marker proves it's a new shell.
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 20_000 })
  await expect(page.locator('.xterm-rows:visible')).not.toContainText(marker)

  // The background tab must reconnect too - closeTab expects a live "close session?" confirm,
  // which only appears once a tab is connected.
  await tabButtons.first().click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 20_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)

  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'restore test host')
})
