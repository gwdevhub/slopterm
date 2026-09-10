import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTab, ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
}

// The one tab kind that needs no server: a shell on the machine slopterm runs on. Nothing
// here touches the sshd container, so it would still run on a machine with no Docker.
async function openLocalShell(page: Page) {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await page.getByRole('button', { name: 'Local shell' }).click()
  await expect(page.locator('.xterm-rows:visible')).toBeVisible({ timeout: 15_000 })
}

// The tab's label is built from whichever shell actually launched ("bash (local)", "sh
// (local)"), so nothing here hard-codes a shell a given machine may not have.
async function localTabLabel(page: Page): Promise<string> {
  const label = page.locator('button:has-text("(local)")').first()
  await expect(label).toBeVisible({ timeout: 15_000 })
  return (await label.innerText()).trim()
}

// Types a command and waits for a marker only the shell can produce, so the assertion can't
// pass on the echoed input alone.
async function run(page: Page, command: string, expected: string) {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await page.locator('.xterm-rows:visible').innerText()).toContain(expected)
  }).toPass({ timeout: 15_000 })
}

test('a local shell opens in its own tab and runs commands on this machine', async ({ page }) => {
  await openLocalShell(page)
  const tabLabel = await localTabLabel(page)

  await run(page, 'echo LOCAL-$((6*7))', 'LOCAL-42')

  // `tty` names a device only with a controlling terminal (else "not a tty"), proving a real
  // PTY - without one there's no job control, no Ctrl+C and no window size.
  await run(page, 'tty', '/dev/')

  await closeTab(page, tabLabel)
})

test('a local tab reattaches to the same shell across a reload', async ({ page }) => {
  await openLocalShell(page)
  const tabLabel = await localTabLabel(page)

  // A local session outlives its WebSocket like an SSH one, so a reload must reattach rather
  // than start a fresh shell that knows nothing of the marker.
  await run(page, 'echo BEFORE-RELOAD-MARKER', 'BEFORE-RELOAD-MARKER')
  await page.reload()
  await ensureVaultUnlocked(page)
  await expect(async () => {
    expect(await page.locator('.xterm-rows:visible').innerText()).toContain('BEFORE-RELOAD-MARKER')
  }).toPass({ timeout: 20_000 })

  await closeTab(page, tabLabel)
})

test('a local tab is not restored once its shell is gone', async ({ page }) => {
  await openLocalShell(page)
  const tabLabel = await localTabLabel(page)
  await run(page, 'echo LOCAL-TAB-OPEN', 'LOCAL-TAB-OPEN')

  // The tab is persisted so a reload can reattach to a LIVE session, but a local shell has no
  // destination or credential - once gone there's nothing to restore it from.
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: `Close ${tabLabel}` })).toHaveCount(0, { timeout: 20_000 })

  await page.reload()
  await ensureVaultUnlocked(page)
  await expect(page.getByRole('button', { name: `Close ${tabLabel}` })).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByText('Reconnecting')).toHaveCount(0)
})

test('exiting a local shell closes its tab instead of reconnecting it', async ({ page }) => {
  await openLocalShell(page)
  const tabLabel = await localTabLabel(page)
  await run(page, 'echo READY-TO-EXIT', 'READY-TO-EXIT')

  // An SSH tab treats an ambiguous EOF as "reconnect", but a local shell has no transport that
  // could merely have blipped, so `exit` must close the tab instead of respawning a shell.
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: `Close ${tabLabel}` })).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByText('Reconnecting')).toHaveCount(0)
})
