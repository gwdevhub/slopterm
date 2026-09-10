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

// Same scoping as keyboard-toolbar's terminalText: the shared server keeps every tab ever
// opened mounted, so stay pinned to whichever one is focused right now.
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

// Playwright has no real IME, so these dispatch the composition events a mobile keyboard would;
// the bridge half is exercised via a mocked window.SloptermAndroid below.
//
// Two overlays share .composition-view: xterm's own live preview and TerminalView's
// .composition-echo snapshot (the one that must survive the commit), hence the :not() on liveness.
const LIVE_PREVIEW = '.composition-view:not(.composition-echo)'
const FROZEN_PREVIEW = '.composition-echo'
test.describe('with touch emulation', () => {
  test.use({ hasTouch: true })

  test('a composed word stays visible through compositionend instead of flashing blank', async ({ page }) => {
    await connectHost(page, 'composition freeze test host')

    const compositionView = page.locator(LIVE_PREVIEW)
    const frozenPreview = page.locator(FROZEN_PREVIEW)

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

    // xterm hides the live overlay synchronously on compositionend and sends the text on a
    // later tick; asserting in the SAME evaluate() call makes this deterministic regardless of echo speed.
    const immediatelyAfterEnd = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'hello' }))
      const view = document.querySelector('.composition-echo')!
      return { active: view.classList.contains('active'), text: view.textContent }
    })
    expect(immediatelyAfterEnd).toEqual({ active: true, text: 'hello' })

    // ...but it must not stay frozen forever either - once the shell's real echo (or, failing
    // that, the fixed backstop timeout) supersedes it, the preview has to actually clear.
    await expect(async () => {
      const stillActive = await frozenPreview.evaluate((el) => el.classList.contains('active'))
      expect(stillActive).toBe(false)
    }).toPass({ timeout: 5_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'composition freeze test host')
  })

  test('a composed word stays visible when committed by pressing Enter, not just Space', async ({ page }) => {
    await connectHost(page, 'composition freeze enter test host')

    const compositionView = page.locator(LIVE_PREVIEW)
    const frozenPreview = page.locator(FROZEN_PREVIEW)

    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.value = ''
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value = 'hello'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'hello' }))
    })
    await expect(compositionView).toHaveClass(/active/)
    await expect(compositionView).toHaveText('hello')

    // Enter mid-composition doesn't fire compositionend - xterm finalizes synchronously in
    // CompositionHelper.keydown, which is what let this regress even after the Space fix (PR #103).
    const immediatelyAfterEnter = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true, cancelable: true }))
      const view = document.querySelector('.composition-echo')!
      return { active: view.classList.contains('active'), text: view.textContent }
    })
    expect(immediatelyAfterEnter).toEqual({ active: true, text: 'hello' })

    await expect(async () => {
      const stillActive = await frozenPreview.evaluate((el) => el.classList.contains('active'))
      expect(stillActive).toBe(false)
    }).toPass({ timeout: 5_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'composition freeze enter test host')
  })

  test('a committed word survives the IME immediately opening the next composition', async ({ page }) => {
    await connectHost(page, 'composition restart test host')

    const frozenPreview = page.locator(FROZEN_PREVIEW)

    // Commit "hello", then let the IME open a fresh composition right away - CompositionHelper
    // .compositionstart blanks .composition-view, which is why the snapshot exists.
    const afterRestart = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.value = ''
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value = 'hello'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'hello' }))
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'hello' }))
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      const frozen = document.querySelector('.composition-echo')!
      const live = document.querySelector('.composition-view:not(.composition-echo)')!
      return {
        frozen: { active: frozen.classList.contains('active'), text: frozen.textContent },
        liveText: live.textContent,
      }
    })
    // liveText pins down the old failure mode: xterm's own overlay really is blank-but-active
    // here, so re-activating it showed an empty box.
    expect(afterRestart).toEqual({ frozen: { active: true, text: 'hello' }, liveText: '' })

    // It must yield to the next word being previewed, though - both overlays sit on the same
    // cursor cell, so leaving the old one up would draw the two on top of each other.
    const afterNextWordPreviewed = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      // Appended, not replaced: the textarea accumulates across compositions, and xterm reads
      // the committed text back out of it by offset (CompositionHelper._compositionPosition).
      ta.value = 'helloworld'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'world' }))
      return document.querySelector('.composition-echo')!.classList.contains('active')
    })
    expect(afterNextWordPreviewed).toBe(false)

    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'world' }))
    })
    await expect(async () => {
      expect(await terminalText(page)).toContain('helloworld')
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'composition restart test host')
  })

  test('a toolbar button waits for a delayed native composition commit before acting', async ({ page }) => {
    // Stands in for SloptermAndroid.finishComposing(), which posts the commit into the WebView
    // and returns before the page processes it; firing compositionend on a delay reproduces that gap.
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
    // Opened ahead of time so the marker action is a second toolbar button, not a real keystroke
    // (a real keydown would self-finalize the composition and mask whether this fix's wait does anything).
    await page.getByRole('button', { name: 'More keys' }).click()

    // Compose "al" the way a real word gets composed, left deliberately uncommitted.
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value += 'al'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'al' }))
    })
    await expect(page.locator(LIVE_PREVIEW)).toHaveText('al')

    // Correct behavior waits for the (artificially delayed) native commit before the arrow's
    // bytes; a second tap within the 50ms window queues onto the same wait (the resolver queue).
    await page.getByRole('button', { name: 'Left' }).click()
    await page.getByRole('button', { name: 'Pipe', exact: true }).click()

    // Correct order - "-al" commits, the cursor steps left, "|" lands before the trailing "l":
    // "echo ls -a|l". Racing ahead (the bug) moves the cursor before "-al" exists at all.
    await expect(async () => {
      expect(await terminalText(page)).toContain('echo ls -a|l')
    }).toPass({ timeout: 10_000 })

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'toolbar composition race test host')
  })

  test('a double tap completes the word the IME is still composing, not the one before it', async ({ page }) => {
    // Same stand-in for MainActivity's SloptermAndroid.finishComposing() as the tests above.
    await page.addInitScript(() => {
      ;(window as unknown as { SloptermAndroid: unknown }).SloptermAndroid = {
        saveFile: () => {},
        finishComposing: () => {
          const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          setTimeout(() => ta?.dispatchEvent(new CompositionEvent('compositionend', { data: '' })), 20)
        },
      }
    })

    await connectHost(page, 'double tap completion test host')

    // Two files sharing a prefix, so the completion's answer says which text the shell had:
    // committed first the prefix is unique and completes, otherwise it's ambiguous and completes to nothing.
    const stamp = Date.now()
    await page.keyboard.type(`touch /tmp/tabA${stamp}.log /tmp/tabB${stamp}.log && clear`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)

    await page.keyboard.type('ls /tmp/tab')
    await page.evaluate((suffix) => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value += suffix
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: suffix }))
    }, `A${stamp}`)
    await expect(page.locator(LIVE_PREVIEW)).toHaveText(`A${stamp}`)

    // Two taps inside the double-tap window (see DOUBLE_TAP_MS in terminalTouch.ts) on the
    // terminal itself - the gesture that stands in for Tab on a touchscreen.
    const box = (await page.locator('.xterm-rows.xterm-focus').boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)

    await expect(async () => {
      expect(await terminalText(page)).toContain(`tabA${stamp}.log`)
    }).toPass({ timeout: 10_000 })
    // The other half of it: a Tab that raced ahead of the commit would have completed the bare
    // "/tmp/tab" prefix, which matches both files and lists them.
    expect(await terminalText(page)).not.toContain(`tabB${stamp}.log`)

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'double tap completion test host')
  })

  test('an armed Ctrl applies to a character the IME is still composing', async ({ page }) => {
    // Same finishComposing stand-in as above: it commits what the IME holds. Without it the
    // composed character never reaches the terminal - Ctrl+O in nano sat in the composing region.
    await page.addInitScript(() => {
      ;(window as unknown as { SloptermAndroid: unknown }).SloptermAndroid = {
        saveFile: () => {},
        finishComposing: () => {
          const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          setTimeout(() => ta?.dispatchEvent(new CompositionEvent('compositionend', { data: '' })), 20)
        },
      }
    })

    await connectHost(page, 'ctrl composition test host')

    // A command line deliberately left un-run: Ctrl+C has to abandon it.
    await page.keyboard.type('echo CTRL_C_SHOULD_KILL_THIS')
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
    await ctrl.click()
    await expect(ctrl).toHaveAttribute('aria-pressed', 'true')

    // "c" typed on an on-screen keyboard: held in the composing region, not handed to the
    // terminal, exactly as Gboard does it.
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value += 'c'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'c' }))
    })

    // The shell echoes the interrupt as "^C" and drops the line - a literal "c" (the bug)
    // would just extend the command instead.
    await expect(async () => {
      expect(await terminalText(page)).toContain('CTRL_C_SHOULD_KILL_THIS^C')
    }).toPass({ timeout: 10_000 })
    // One-shot: having been applied, the modifier disarms itself.
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false')

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'ctrl composition test host')
  })
  test('the caret follows the composing word instead of sitting at its first letter', async ({ page }) => {
    await connectHost(page, 'composition caret test host')

    // Nothing composed yet: the terminal's own cursor is the visible caret.
    expect(await page.evaluate(() => document.querySelectorAll('.xterm-composing').length)).toBe(0)

    const whileComposing = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.value = ''
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      ta.value = 'hello'
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'hello' }))

      // The real cursor stays in the cell the word started in - it can't move, nothing has
      // reached the shell - so it is hidden and the preview carries the caret instead.
      const cursor = document.querySelector('.xterm-composing .xterm-cursor')
      return {
        marked: document.querySelectorAll('.xterm-composing').length,
        cursorHidden: cursor === null ? null : getComputedStyle(cursor).visibility === 'hidden',
      }
    })
    expect(whileComposing.marked).toBe(1)
    // null = this xterm build isn't rendering a cursor element right now; the marker class is
    // what the styling hangs off either way, so don't fail the run over a missing element.
    if (whileComposing.cursorHidden !== null) {
      expect(whileComposing.cursorHidden).toBe(true)
    }

    // Committing hands the word to the shell, whose echo moves the real cursor - so the real
    // cursor comes back the moment composition ends.
    const afterEnd = await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: 'hello' }))
      return document.querySelectorAll('.xterm-composing').length
    })
    expect(afterEnd).toBe(0)

    await closeTab(page, tabLabel)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, 'composition caret test host')
  })
})
