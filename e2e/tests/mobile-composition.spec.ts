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
// .composition-echo snapshot, androidBridge.ts's finishAndroidComposing ordering) is standard
// DOM composition handling underneath, not anything Android-bridge-specific for the freeze
// half, and the bridge half is exercised via a mocked window.SloptermAndroid below.
//
// Two overlays share the .composition-view class: xterm's own live preview and TerminalView's
// .composition-echo snapshot of it, which is the one that has to survive the commit - hence the
// :not() on every locator meaning "xterm's".
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

    // A trailing space (or here, directly ending composition) is the real-world trigger:
    // xterm's own compositionend handling hides this overlay synchronously and only actually
    // sends "hello" to the shell on its own later tick - well before any real network round
    // trip could complete. Asserting the overlay state in the SAME evaluate() call as the
    // dispatch (no round trip to the test process in between) is what makes this deterministic
    // regardless of how fast the real echo happens to come back.
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

    // Commit "hello", then let the IME open a fresh composition right away - what an Android
    // keyboard does the moment Enter starts a new line, and (before this was a snapshot of its
    // own) what silently emptied the frozen word: CompositionHelper.compositionstart blanks
    // .composition-view's textContent, so re-activating that same element left an empty box on
    // screen until the echo arrived. Everything asserted inside one evaluate() so the result
    // can't depend on how fast the real echo comes back.
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
    // liveText pins down the old failure mode rather than any behavior of ours: xterm's own
    // overlay really is blank-but-active at this point, so the previous fix's re-activation of
    // it showed an empty box where the word had been.
    expect(afterRestart).toEqual({ frozen: { active: true, text: 'hello' }, liveText: '' })

    // It does have to yield to the next word actually being previewed, though - both overlays
    // sit on the same cursor cell until the echo moves it, so leaving the old one up would
    // draw the two on top of each other.
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
    await expect(page.locator(LIVE_PREVIEW)).toHaveText('al')

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

    // Two files sharing a prefix, so the completion's answer says which text the shell had when
    // Tab reached it: with the composed half committed first the prefix is unique and completes,
    // without it the prefix is ambiguous and completes to nothing at all.
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
    // Same stand-in for MainActivity's SloptermAndroid.finishComposing() as the test above:
    // it commits whatever the IME is holding, which the page then sees as a real
    // compositionend. Without one of these the composed character never reaches the terminal
    // as its own single character at all - which is the bug: Ctrl+O in nano sat in the
    // composing region, so nano got nothing and the toolbar's Ctrl stayed armed.
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
})
