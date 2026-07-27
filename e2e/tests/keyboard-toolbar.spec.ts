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

// Scoped to the currently-focused terminal specifically (xterm.js's own "xterm-focus"
// class) - every open tab's view stays mounted-but-hidden even while inactive (see
// AGENTS.md's multi-session tabs note), so a plain '.xterm-rows' locator goes ambiguous
// the moment more than one tab has ever been open in this shared-server test run.
function terminalText(page: import('@playwright/test').Page) {
  return page.locator('.xterm-rows.xterm-focus').innerText()
}

const tabLabel = `${ctx.sshUsername}@${ctx.sshHost}`

async function connectHost(page: import('@playwright/test').Page, name: string) {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', name)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: `SSH to ${name}` }).click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })
}

test('the mobile keyboard toolbar is absent without touch support', async ({ page }) => {
  await connectHost(page, 'toolbar visibility test host')
  await expect(page.getByRole('button', { name: 'Ctrl' })).toHaveCount(0)

  await closeTab(page, tabLabel)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'toolbar visibility test host')
})

// isMobileApp() (see androidBridge.ts) falls back to touch-support detection when there's
// no native Android bridge - Playwright's hasTouch context option is what actually flips
// that check, not viewport size (see sidebar.spec.ts's mobile-*width* test for the
// unrelated, CSS-breakpoint-driven "mobile menu overlay").
test.describe('with touch emulation', () => {
  test.use({ hasTouch: true })

  test('the Up-arrow button recalls shell history via a real ANSI cursor sequence', async ({ page }) => {
    await connectHost(page, 'toolbar arrow test host')
    await expect(page.getByRole('button', { name: 'Ctrl' })).toBeVisible()

    const marker = `PLAYWRIGHT_TOOLBAR_${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(marker)
    }).toPass({ timeout: 10_000 })

    // Running it once already puts the marker in the transcript twice - the PTY's own
    // local echo of the typed command line, then the command's actual output. Recalling
    // and re-running it (proves the button sent the real ESC [ A cursor-up sequence, not
    // a raw uparrow keycode xterm would otherwise ignore outside an actual keydown) adds
    // two more occurrences.
    await page.getByRole('button', { name: 'Up' }).click()
    await page.keyboard.press('Enter')
    await expect(async () => {
      const occurrences = (await terminalText(page)).split(marker).length - 1
      expect(occurrences).toBe(4)
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar arrow test host')
  })

  test('arming Ctrl and typing "c" sends a real interrupt to a running command', async ({ page }) => {
    await connectHost(page, 'toolbar ctrl test host')

    await page.keyboard.type('sleep 30; echo SLEEP_FINISHED_NORMALLY')
    await page.keyboard.press('Enter')

    const ctrlButton = page.getByRole('button', { name: 'Ctrl' })
    await ctrlButton.click()
    await expect(ctrlButton).toHaveAttribute('aria-pressed', 'true')

    // The armed modifier is consumed by the very next single-character keydown - this "c"
    // must never reach the shell as a literal character (which would just make bash wait
    // for more input on a blank second line, not print anything).
    await page.keyboard.type('c')
    await expect(ctrlButton).toHaveAttribute('aria-pressed', 'false')

    // A fresh command right after only completes quickly if sleep 30 was actually
    // interrupted (0x03) rather than still running in the foreground for the rest of its
    // 30s - the 10s timeout here would otherwise be far too short to pass.
    const marker = `PLAYWRIGHT_AFTER_INTERRUPT_${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(marker)
    }).toPass({ timeout: 10_000 })
    // (Not asserting the transcript never contains "SLEEP_FINISHED_NORMALLY" - the typed
    // command line itself echoes that substring regardless of whether it ran; the marker
    // appearing this quickly is what actually proves the interrupt worked.)

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar ctrl test host')
  })

  // Tab-completion's actual visible effect depends on what's installed in the target
  // shell (bash-completion, PATH contents, ...) - not asserted on precisely, and Tab is
  // deliberately excluded from this generic click-through: tapping it against a genuinely
  // empty prompt (as this loop otherwise would) lists every $PATH executable and drops the
  // session into a `less` pager waiting for input, which would then eat the marker command
  // typed below instead of running it. Escape/Insert/Delete's readline bindings have no
  // single universal observable side effect either - too environment-fragile to assert on
  // precisely. This only smoke-tests that tapping every remaining button is wired up and
  // doesn't throw/disconnect the session, not each one's exact remote effect.
  test('Escape/Insert/Delete/Alt/Shift/arrow buttons are clickable without disconnecting the session', async ({ page }) => {
    await connectHost(page, 'toolbar smoke test host')

    for (const label of ['Escape', 'Insert', 'Delete', 'Alt', 'Shift', 'Left', 'Down', 'Right']) {
      await page.getByRole('button', { name: label, exact: true }).click()
    }
    // Alt is a sticky modifier (see TerminalView) - the tap above armed it, and it would
    // otherwise intercept the very next character typed below instead of letting it
    // through as literal input. Tap it again to disarm before typing normally.
    await page.getByRole('button', { name: 'Alt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Alt', exact: true })).toHaveAttribute('aria-pressed', 'false')

    const marker = `PLAYWRIGHT_TOOLBAR_SMOKE_${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(marker)
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar smoke test host')
  })
})
