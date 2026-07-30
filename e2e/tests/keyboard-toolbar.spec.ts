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
  await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveCount(0)

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
    // Named keys spell their own name out rather than wearing an icon - the accessible name
    // and the visible label are the same string on purpose.
    await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveText('Ctrl')

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

    const ctrlButton = page.getByRole('button', { name: 'Ctrl', exact: true })
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
  test('Escape/Insert/Delete/Alt/arrow buttons are clickable without disconnecting the session', async ({ page }) => {
    await connectHost(page, 'toolbar smoke test host')

    // Everything past the always-visible row lives behind "More keys" (see KeyboardToolbar).
    await page.getByRole('button', { name: 'More keys' }).click()
    for (const label of ['Escape', 'Insert', 'Delete', 'Home', 'End', 'Page Up', 'Page Down', 'Alt', 'Left', 'Down', 'Right']) {
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

  test('"More keys" toggles the extra rows the always-visible row deliberately leaves out', async ({ page }) => {
    await connectHost(page, 'toolbar more keys test host')

    const moreKeys = page.getByRole('button', { name: 'More keys' })
    await expect(moreKeys).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: 'Shift+Tab' })).toHaveCount(0)

    await moreKeys.click()
    await expect(moreKeys).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: 'Shift+Tab' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'F12' })).toBeVisible()

    await moreKeys.click()
    await expect(page.getByRole('button', { name: 'Shift+Tab' })).toHaveCount(0)

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar more keys test host')
  })

  test('a symbol key types its literal character and the ^C key interrupts the line', async ({ page }) => {
    await connectHost(page, 'toolbar symbol test host')
    await page.getByRole('button', { name: 'More keys' }).click()

    // A bare pipe is the cheapest observable proof the key sent the literal character: the
    // PTY echoes it straight back at the prompt.
    await page.getByRole('button', { name: 'Pipe', exact: true }).click()
    await expect(async () => {
      expect(await terminalText(page)).toContain('|')
    }).toPass({ timeout: 10_000 })

    // ...and it's also why ^C has to work: pressing Enter on a dangling pipe would drop bash
    // into its PS2 continuation prompt and swallow the marker command below. Reaching the
    // marker at all is what proves the key sent a real 0x03 rather than a literal "^C".
    await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click()
    const marker = `PLAYWRIGHT_TOOLBAR_SYMBOL_${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      const occurrences = (await terminalText(page)).split(marker).length - 1
      expect(occurrences).toBe(2)
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar symbol test host')
  })

  test('the always-visible row holds exactly the nine keys it should, in order', async ({ page }) => {
    await connectHost(page, 'toolbar layout test host')

    // Left-to-right order is deliberate (arrows read left/right before up/down), and this is
    // also what pins the row to nine equal grid cells - the previous scrolling row let the
    // last key slide half underneath the panel toggle on a narrow phone.
    const keys = page.locator('[aria-label="Terminal keys"] button')
    await expect(keys).toHaveCount(9)
    expect(await keys.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))).toEqual([
      'Escape',
      'Tab',
      'Ctrl',
      'Snippets',
      'Left',
      'Right',
      'Up',
      'Down',
      'More keys',
    ])

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar layout test host')
  })

  test('the Snippets key pastes a saved snippet at the prompt without running it', async ({ page }) => {
    const marker = `PLAYWRIGHT_TOOLBAR_SNIPPET_${Date.now()}`
    await page.goto(ctx.baseUrl)
    await gotoSection(page, 'Snippets')
    await ensureVaultUnlocked(page)
    await page.click('button:has-text("New snippet")')
    await page.fill('input[placeholder=Name]', 'toolbar paste snippet')
    await page.fill('textarea[placeholder=Command]', `echo ${marker}`)
    await page.click('button:has-text("Save snippet")')
    await expect(page.getByText('toolbar paste snippet')).toBeVisible({ timeout: 10_000 })

    await connectHost(page, 'toolbar snippet test host')
    // Scoped to the toolbar - the sidebar has its own "Snippets" nav button.
    await page.locator('[aria-label="Terminal keys"]').getByRole('button', { name: 'Snippets' }).click()
    await page.getByText('toolbar paste snippet').click()

    // Pasted, not executed: the command line is on screen exactly once (the PTY's echo of the
    // paste) and its output hasn't been printed, because nobody pressed Enter yet.
    await expect(async () => {
      expect(await terminalText(page)).toContain(`echo ${marker}`)
    }).toPass({ timeout: 10_000 })
    expect((await terminalText(page)).split(marker).length - 1).toBe(1)

    // Enter is the user's own decision, and then it runs - a second occurrence, the output.
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect((await terminalText(page)).split(marker).length - 1).toBe(2)
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar snippet test host')
    await page.evaluate(async (name) => {
      const saved = (await (await fetch('/api/vault/snippets')).json()) as { id: string; snippet: { name: string } }[]
      const match = saved.find((entry) => entry.snippet.name === name)
      if (match) await fetch(`/api/vault/snippets/${match.id}`, { method: 'DELETE' })
    }, 'toolbar paste snippet')
  })

  test('double-tapping the terminal completes the current word, like tapping Tab', async ({ page }) => {
    await connectHost(page, 'toolbar double tap test host')

    // A file whose name only this test knows, so the completion below has exactly one
    // candidate and its result is unambiguous.
    const marker = `tabtest${Date.now()}`
    await page.keyboard.type(`touch ${marker}_unique_file`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect((await terminalText(page)).split(`${marker}_unique_file`).length - 1).toBe(1)
    }).toPass({ timeout: 10_000 })

    await page.keyboard.type(`ls ${marker}_uni`)
    const terminal = page.locator('.xterm-screen').last()
    const box = (await terminal.boundingBox())!
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)

    // The half-typed name became the whole name - which only happens if the double tap put a
    // real \t on the wire (and the file itself is never listed, since nothing pressed Enter).
    await expect(async () => {
      expect((await terminalText(page)).split(`${marker}_unique_file`).length - 1).toBe(2)
    }).toPass({ timeout: 10_000 })

    // Clean the file up on the remote - the container is shared by the whole run.
    await page.keyboard.press('Enter')
    await page.keyboard.type(`rm -f ${marker}_unique_file`)
    await page.keyboard.press('Enter')

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar double tap test host')
  })

  test('the toolbar stays above the on-screen keyboard instead of under it', async ({ page }) => {
    await connectHost(page, 'toolbar keyboard inset test host')

    const toolbar = page.getByRole('button', { name: 'More keys' })
    const before = await toolbar.boundingBox()
    const windowHeight = await page.evaluate(() => window.innerHeight)
    expect(before!.y + before!.height).toBeGreaterThan(windowHeight - 100)

    // Android Chrome doesn't shrink the layout viewport when the keyboard opens - it only
    // shrinks the *visual* viewport - so that's what this emulates. Playwright has no keyboard
    // emulation, and asserting on the real thing needs a device.
    const keyboardHeight = 300
    await page.evaluate((height) => {
      const viewport = window.visualViewport!
      Object.defineProperty(viewport, 'height', { configurable: true, value: window.innerHeight - height })
      viewport.dispatchEvent(new Event('resize'))
    }, keyboardHeight)

    await expect(async () => {
      const after = await toolbar.boundingBox()
      expect(after!.y + after!.height).toBeLessThanOrEqual(windowHeight - keyboardHeight)
    }).toPass({ timeout: 5_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar keyboard inset test host')
  })
})
