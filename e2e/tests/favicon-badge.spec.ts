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

const faviconHref = (page: import('@playwright/test').Page) =>
  page.locator("link[rel~='icon']").first().getAttribute('href')

// Decodes the current favicon and samples a pixel inside the badge fill but off the white
// digit (left of centre) so we can tell the neutral count badge from the accent-colored
// "unseen activity" one by its blue channel. Returns null when no PNG badge is set.
async function badgeFill(page: import('@playwright/test').Page): Promise<number[] | null> {
  return page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>("link[rel~='icon']")?.getAttribute('href') ?? ''
    if (!href.startsWith('data:image/png')) return null
    const img = await new Promise<HTMLImageElement>((r) => {
      const i = new Image()
      i.onload = () => r(i)
      i.src = href
    })
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const x = c.getContext('2d')!
    x.drawImage(img, 0, 0, 64, 64)
    // Badge is centred at (43,43), r=19; sample 13px left of centre - inside the fill, clear
    // of the digit glyph.
    const d = x.getImageData(30, 43, 1, 1).data
    return [d[0], d[1], d[2]]
  })
}

function terminalText(page: import('@playwright/test').Page) {
  return page.locator('.xterm-rows:visible').innerText()
}

// Why this spec has to be careful about *when* it leaves a tab: the badge is one global
// flag - App.tsx turns it accent while ANY background tab holds unseen output, and a tab
// only clears when it is itself viewed again. So a single stray byte landing in a tab the
// test has already moved on from pins the badge accent for the rest of the run, and the
// final "viewing the tab clears it" assertion can never pass. The sshd's banner and first
// prompt arrive as several chunks, and on a slow machine their tail lands after the test
// has navigated to Hosts to open the next tab - i.e. while that tab is already in the
// background. That is what turned this test red on CI (and, being fatal before its own
// cleanup, took 46 later tests with it).
//
// Waits until the visible terminal stops changing (two identical samples in a row).
async function waitForQuietTerminal(page: import('@playwright/test').Page, intervalMs = 500) {
  let previous: string | null = null
  await expect(async () => {
    const current = await terminalText(page)
    const settled = previous !== null && current === previous
    previous = current
    expect(settled).toBeTruthy()
  }).toPass({ timeout: 15_000, intervals: [intervalMs] })
}

test('the favicon tab badge counts tabs and turns accent on unseen background output', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'badge test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('badge test host')).toBeVisible({ timeout: 10_000 })

  // Off by default: the favicon is still the plain SVG.
  expect(await faviconHref(page)).toBe('/favicon.svg')

  // Enable it in Settings.
  await gotoSection(page, 'Settings')
  await page.getByRole('button', { name: 'Show open-tab count on the app icon' }).click()

  // Still no tabs open, so nothing to badge yet.
  expect(await faviconHref(page)).toBe('/favicon.svg')

  // Open a session - the favicon becomes a generated PNG, and with the tab active (its output
  // is "seen") the badge is the neutral slate, not the accent.
  async function openSsh(marker: string) {
    await gotoSection(page, 'Hosts')
    await page.getByRole('button', { name: 'SSH to badge test host' }).click()
    await expect(async () => {
      expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
    }).toPass({ timeout: 15_000 })
    // The banner is not the last thing the shell sends, so don't leave on the strength of
    // it. Round-trip a marker first: the PTY is one ordered stream, so the marker coming
    // back proves everything the shell had queued ahead of it has already been delivered -
    // no guessing at how long a slow runner might stretch the gaps between banner chunks.
    // Then let the prompt that follows the marker land too, which is a matter of timing
    // rather than ordering and so is all the quiet-terminal wait is left to cover.
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(marker)
    }).toPass({ timeout: 10_000 })
    await waitForQuietTerminal(page)
  }
  await openSsh('BADGE_TAB_ONE_READY')
  await expect(async () => expect(await faviconHref(page)).toMatch(/^data:image\/png/)).toPass({ timeout: 5_000 })
  await expect(async () => {
    const px = await badgeFill(page)
    expect(px && px[2] < 160).toBeTruthy() // neutral slate: low blue
  }).toPass({ timeout: 5_000 })

  // Open a second tab (now active), queue delayed output in it, then switch back to the first
  // tab so the second is in the background when its output lands - that must flip the badge to
  // the accent color (high blue).
  await openSsh('BADGE_TAB_TWO_READY')
  await page.keyboard.type('sleep 1 && echo BADGE_LATER')
  await page.keyboard.press('Enter')
  // Let the echo of the typed line land while this tab is still the active one, so the
  // badge below can only be reacting to the delayed BADGE_LATER. A short interval keeps
  // the settle well inside the `sleep 1` window.
  await waitForQuietTerminal(page, 150)
  const tabs = page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}`, exact: true })
  await tabs.first().click()
  await expect(async () => {
    const px = await badgeFill(page)
    expect(px && px[2] > 160).toBeTruthy() // accent indigo: high blue
  }).toPass({ timeout: 10_000 })

  // Viewing the tab clears the unseen flag - the badge goes back to neutral.
  await tabs.last().click()
  await expect(async () => {
    const px = await badgeFill(page)
    expect(px && px[2] < 160).toBeTruthy()
  }).toPass({ timeout: 5_000 })

  // Turning the feature off restores the plain favicon.
  await gotoSection(page, 'Settings')
  await page.getByRole('button', { name: 'Show open-tab count on the app icon' }).click()
  expect(await faviconHref(page)).toBe('/favicon.svg')

  // Clean up (shared vault - other specs assert against it).
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'badge test host')
})

// The whole suite shares one server and one vault (see vault-helpers.ts), and open tabs are
// persisted server-side - so anything this spec leaves behind when it fails part-way through
// is still there for every spec that runs after it, where a spare tab makes `.xterm-rows`
// ambiguous and a spare host card means "No saved hosts yet." never appears. That turned one
// failure here into 46. Sweep up defensively so a failure stays this spec's own.
test.afterEach(async ({ page }) => {
  try {
    const closeButtons = page.getByRole('button', { name: /^Close .+@/ })
    for (let remaining = await closeButtons.count(); remaining > 0; remaining--) {
      await closeButtons.first().click()
      await page.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await gotoSection(page, 'Hosts')
    const editHost = page.getByRole('button', { name: 'Edit badge test host' })
    if (await editHost.isVisible().catch(() => false)) await deleteHost(page, 'badge test host')
  } catch {
    // Best-effort - never mask the real failure with a cleanup error.
  }
})
