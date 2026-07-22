import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTab, ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

// A real drag-resize fires roughly one ResizeObserver notification per frame - confirmed
// by instrumenting it directly against this exact codebase (~30 notifications over half a
// second of dragging). Before TerminalView.tsx debounced fitAddon.fit(), each one called
// straight through to xterm's renderer, which does a full clear-and-redraw whenever the
// computed cols/rows actually change (measured via a MutationObserver on .xterm-screen's
// style attribute, which xterm rewrites on every real resize): 17 redraws for one ~550ms
// resize burst pre-fix, vs exactly 1 (after settling) post-fix. That redraw pileup is what
// read as flicker. This test locks in the fix by asserting the redraw count stays low
// across an equivalent burst, rather than testing for literal "no flicker" (unobservable
// through the DOM).
test('resizing the window doesn\'t cause the terminal to redraw on every intermediate frame', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 })

  await page.addInitScript(() => {
    ;(window as unknown as { __screenMutations: number }).__screenMutations = 0
    const win = window as unknown as { __screenMutations: number }
    const wait = setInterval(() => {
      const el = document.querySelector('.xterm-screen')
      if (el) {
        clearInterval(wait)
        new MutationObserver((records) => {
          win.__screenMutations += records.length
        }).observe(el, { attributes: true, attributeFilter: ['style'] })
      }
    }, 50)
  })

  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("Quick connect")')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(async () => {
    expect(await page.locator('.xterm-rows:visible').innerText()).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  // Enough scrollback that the terminal's own vertical scrollbar is genuinely active, not
  // just a short/empty buffer - the reported bug was specifically about resizing once a
  // scrollbar is in the picture.
  await page.keyboard.type('seq 1 2000')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  await page.evaluate(() => {
    ;(window as unknown as { __screenMutations: number }).__screenMutations = 0
  })

  // A fast, continuous shrink across a wide height range - crosses many row-count
  // boundaries (and whatever scrollbar-related thresholds exist) in one burst, the same
  // shape as a real drag-resize.
  for (let h = 700; h >= 300; h -= 5) {
    await page.setViewportSize({ width: 1000, height: h })
  }

  const immediately = await page.evaluate(
    () => (window as unknown as { __screenMutations: number }).__screenMutations,
  )
  // Redraws happen right after the debounce window closes, not mid-burst - assert that
  // separately below instead of demanding zero forever.
  expect(immediately).toBeLessThanOrEqual(2)

  await page.waitForTimeout(300)
  const afterSettle = await page.evaluate(
    () => (window as unknown as { __screenMutations: number }).__screenMutations,
  )
  // Pre-fix this was 17 for an equivalent burst - a handful (not dozens) confirms the
  // debounce is coalescing the burst into a small number of final redraws rather than one
  // per intermediate frame.
  expect(afterSettle).toBeLessThanOrEqual(3)

  // Restore a normal viewport before closing - other spec files run at the default size
  // and this is a shared vault/session (see vault-helpers.ts), so this ad hoc connection
  // must not linger as a "restore on next load" tab for a later test to trip over.
  await page.setViewportSize({ width: 1280, height: 800 })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
})
