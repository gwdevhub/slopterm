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

// Same scoping rationale as keyboard-toolbar.spec.ts's terminalText: the shared server keeps
// every tab this whole run has ever opened mounted, so this has to stay pinned to whichever
// one is actually focused right now.
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

// Playwright has no real IME to drive, so these dispatch the same compositionstart/update/end
// events a mobile on-screen keyboard would - the actual behavior under test (TerminalView's
// .composition-view freeze, androidBridge.ts's finishAndroidComposing ordering) is standard
// DOM composition handling underneath, not anything Android-bridge-specific for the freeze
// half, and the bridge half is exercised via a mocked window.SloptermAndroid below.
test.describe('with touch emulation', () => {
  test.use({ hasTouch: true })

  test('a composed word stays visible through compositionend instead of flashing blank', async ({ page }) => {
    await connectHost(page, 'composition freeze test host')

    const compositionView = page.locator('.composition-view')

    // Hold "hello" in a composing region, the way a real keyboard does mid-word - xterm
    // renders it via this overlay well before anything reaches the shell.
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.value = ''
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value = 'hello'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'hello' }))
    })
    await expect(compositionView).toHaveClass(/active/)
    await expect(compositionView).toHaveText('hello')

    // A trailing space (or here, directly ending composition) is the real-world trigger:
    // xterm's own compositionend handling hides this overlay synchronously and only actually
    // sends "hello" to the shell on its own later tick - well before any real network round
    // trip could complete. Asserting the overlay state in the SAME evaluate() call as the
    // dispatch (no round trip to the test process in between) is what makes this deterministic
    // regardless of how fast the real echo happens to come back.
    const immediatelyAfterEnd = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'hello' }))
      const view = document.querySelector('.composition-view')!
      return { active: view.classList.contains('active'), text: view.textContent }
    })
    expect(immediatelyAfterEnd).toEqual({ active: true, text: 'hello' })

    // ...but it must not stay frozen forever either - once the shell's real echo (or, failing
    // that, the fixed backstop timeout) supersedes it, the preview has to actually clear.
    await expect(async () => {
      const stillActive = await compositionView.evaluate((el) => el.classList.contains('active'))
      expect(stillActive).toBe(false)
    }).toPass({ timeout: 5_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'composition freeze test host')
  })

  test('a composed word stays visible when committed by pressing Enter, not just Space', async ({ page }) => {
    await connectHost(page, 'composition freeze enter test host')

    const compositionView = page.locator('.composition-view')

    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.value = ''
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value = 'hello'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'hello' }))
    })
    await expect(compositionView).toHaveClass(/active/)
    await expect(compositionView).toHaveText('hello')

    // Enter mid-composition doesn't go through a compositionend event at all - xterm's
    // CompositionHelper.keydown finalizes the composition right there, synchronously, so the
    // composed word reaches the shell before Enter runs the command (see
    // CompositionHelper._finalizeComposition's non-waitForPropagation branch). That hides the
    // composition-view with no compositionend event to hang a freeze off of, which is exactly
    // what let this regress even after the Space case (PR #103) was fixed. Same
    // same-evaluate-call rationale as the compositionend assertion above: nothing here should
    // depend on how fast the real echo comes back.
    const immediatelyAfterEnter = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true, cancelable: true }))
      const view = document.querySelector('.composition-view')!
      return { active: view.classList.contains('active'), text: view.textContent }
    })
    expect(immediatelyAfterEnter).toEqual({ active: true, text: 'hello' })

    await expect(async () => {
      const stillActive = await compositionView.evaluate((el) => el.classList.contains('active'))
      expect(stillActive).toBe(false)
    }).toPass({ timeout: 5_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'composition freeze enter test host')
  })

  test('a toolbar button waits for a delayed native composition commit before acting', async ({ page }) => {
    // Stands in for MainActivity's real SloptermAndroid.finishComposing() - which, in the real
    // bug, posts the commit into the WebView and returns well before the page has actually
    // processed it. Firing the real compositionend on a delay (not synchronously) reproduces
    // that gap: a fix that only awaited the bridge call returning, rather than the actual
    // commit landing, would still send the button's bytes first.
    await page.addInitScript(() => {
      ;(window as unknown as { SloptermAndroid: unknown }).SloptermAndroid = {
        saveFile: () => {},
        finishComposing: () => {
          const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          setTimeout(() => ta?.dispatchEvent(new CompositionEvent('compositionend', { data: '' })), 50)
        },
      }
    })

    await connectHost(page, 'toolbar composition race test host')

    await page.keyboard.type('echo ls -')
    // Opened ahead of time (composing is still false here, so this click resolves with no
    // wait) so the marker action below is a second toolbar button, not a real keystroke - a
    // real keydown while xterm still considers itself composing self-finalizes the composition
    // on its own via CompositionHelper.keydown(), which would mask whether this fix's own
    // explicit wait is doing anything.
    await page.getByRole('button', { name: 'More keys' }).click()

    // Compose "al" the way a real word gets composed, left deliberately uncommitted.
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value += 'al'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'al' }))
    })
    await expect(page.locator('.composition-view')).toHaveText('al')

    // Left arrow, with nothing committed yet - correct behavior waits for the (artificially
    // delayed) native commit to actually land before the arrow's own bytes go out. Pipe right
    // after (still within the fake 50ms native delay) queues onto the very same wait rather
    // than displacing it - two toolbar taps landing close together while a commit is still
    // pending is exactly the scenario the resolver queue in androidBridge.ts exists for.
    await page.getByRole('button', { name: 'Left' }).click()
    await page.getByRole('button', { name: 'Pipe', exact: true }).click()

    // Correct order - "-al" commits, the cursor then steps left one, and "|" lands right
    // before the trailing "l": "echo ls -a|l". Racing ahead (the bug) moves the cursor before
    // "-al" exists at all, landing "|" somewhere that doesn't reflect it.
    await expect(async () => {
      expect(await terminalText(page)).toContain('echo ls -a|l')
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar composition race test host')
  })
})
