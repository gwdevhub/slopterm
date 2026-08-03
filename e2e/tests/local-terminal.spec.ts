import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTab, ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
}

// The one tab kind that needs no server at all: a shell on the machine slopterm is running
// on. Unlike every other terminal spec here, nothing in this file touches the disposable
// sshd container - which is the point, and also why it's the one terminal spec that would
// still run on a machine with no Docker.
async function openLocalShell(page: Page) {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await page.getByRole('button', { name: 'Local shell' }).click()
  await expect(page.locator('.xterm-rows:visible')).toBeVisible({ timeout: 15_000 })
}

// The tab's own label, which the backend built from whichever shell it actually launched
// ("bash (local)", "sh (local)") - so nothing here hard-codes a shell that a given machine
// may not have.
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

  // Proves this is a real PTY rather than a pair of pipes: `tty` only names a terminal
  // device when the shell has a controlling terminal, and prints "not a tty" when it
  // doesn't. Without one there'd be no job control, no Ctrl+C and no window size.
  await run(page, 'tty', '/dev/')

  await closeTab(page, tabLabel)
})

test('a local tab reattaches to the same shell across a reload', async ({ page }) => {
  await openLocalShell(page)
  const tabLabel = await localTabLabel(page)

  // Leaves a marker in the scrollback, reloads, and expects to land back on the SAME shell:
  // a local session outlives its WebSocket exactly like an SSH one, so a reload has to
  // reattach rather than start a second shell that would know nothing about this.
  await run(page, 'echo BEFORE-RELOAD-MARKER', 'BEFORE-RELOAD-MARKER')
  await page.reload()
  await ensureVaultUnlocked(page)
  await expect(async () => {
    expect(await page.locator('.xterm-rows:visible').innerText()).toContain('BEFORE-RELOAD-MARKER')
  }).toPass({ timeout: 20_000 })

  await closeTab(page, tabLabel)
})

test('exiting a local shell closes its tab instead of reconnecting it', async ({ page }) => {
  await openLocalShell(page)
  const tabLabel = await localTabLabel(page)
  await run(page, 'echo READY-TO-EXIT', 'READY-TO-EXIT')

  // A local shell has no transport that could merely have blipped, so `exit` has exactly one
  // meaning and the tab must go. That's what LocalShellChannel reporting CanLoseTransport as
  // false buys: an SSH tab treats an ambiguous EOF as "reconnect", and a local tab doing the
  // same would silently respawn a shell the user just closed.
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: `Close ${tabLabel}` })).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByText('Reconnecting')).toHaveCount(0)
})
