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

// A real drag-resize fires ~one ResizeObserver notification per frame; before the debounce
// each one redrew (17 redraws pre-fix vs 1 post-fix), which read as flicker.
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

  // Enough scrollback that the terminal's own scrollbar is active - the reported bug was
  // specifically about resizing once a scrollbar is in the picture.
  await page.keyboard.type('seq 1 2000')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  await page.evaluate(() => {
    ;(window as unknown as { __screenMutations: number }).__screenMutations = 0
  })

  // A fast shrink crosses many row-count boundaries in one burst, the same shape as a real
  // drag-resize.
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
  // Pre-fix this was 17 for an equivalent burst - a handful confirms the debounce coalesces
  // the burst instead of one redraw per intermediate frame.
  expect(afterSettle).toBeLessThanOrEqual(3)

  // Restore a normal viewport before closing - this ad hoc session is on the shared server
  // and must not linger as a "restore on next load" tab for a later test.
  await page.setViewportSize({ width: 1280, height: 800 })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
})
