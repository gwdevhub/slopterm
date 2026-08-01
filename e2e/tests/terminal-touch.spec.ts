import { test, expect, type Page } from '@playwright/test'
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

// Same scoping rationale as the other terminal specs: every tab this shared-server run has ever
// opened stays mounted, so this has to stay pinned to whichever one is actually focused.
function terminalText(page: Page) {
  return page.locator('.xterm-rows.xterm-focus').innerText()
}

const tabLabel = `${ctx.sshUsername}@${ctx.sshHost}`

async function connect(page: Page, name: string) {
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

async function cleanup(page: Page, name: string) {
  await closeTab(page, tabLabel)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, name)
}

// Playwright's own touchscreen API can only tap, so a real press-move-release comes from CDP -
// which is also the only way to hold a finger still for a long press, or to move it in steps the
// page sees as separate touchmove events rather than one jump.
type Finger = {
  down: (x: number, y: number) => Promise<void>
  moveTo: (x: number, y: number, steps?: number) => Promise<void>
  up: () => Promise<void>
}

async function finger(page: Page): Promise<Finger> {
  const cdp = await page.context().newCDPSession(page)
  let current = { x: 0, y: 0 }
  return {
    async down(x, y) {
      current = { x, y }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    },
    async moveTo(x, y, steps = 8) {
      const from = current
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps }],
        })
        await page.waitForTimeout(16)
      }
      current = { x, y }
    },
    async up() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    },
  }
}

async function swipe(page: Page, dy: number) {
  // Scoped to the focused terminal for the same reason terminalText is (xterm marks it with
  // .xterm-focus), since every tab this run has opened is still mounted.
  const box = (await page.locator('.xterm-rows.xterm-focus').boundingBox())!
  const touch = await finger(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await touch.down(x, y)
  await touch.moveTo(x, y + dy, 12)
  await touch.up()
  await page.waitForTimeout(200)
}

// The first line number visible in the terminal, for output that is nothing but line numbers.
function firstVisibleNumber(text: string): number {
  const match = text.split('\n').find((line) => /^\d+$/.test(line.trim()))
  return match ? Number(match.trim()) : NaN
}

// Presses and holds long enough for the long-press selection to fire (see LONG_PRESS_MS in
// terminalTouch.ts), optionally dragging on to a second point before letting go.
async function longPress(page: Page, x: number, y: number, dragTo?: { x: number; y: number }) {
  const touch = await finger(page)
  await touch.down(x, y)
  await page.waitForTimeout(700)
  if (dragTo) await touch.moveTo(dragTo.x, dragTo.y, 10)
  await touch.up()
}

async function centreOf(page: Page, word: string) {
  const box = await page.locator('.xterm-rows.xterm-focus').getByText(word, { exact: true }).boundingBox()
  if (!box) throw new Error(`could not find "${word}" in the terminal`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

// hasTouch is what makes the app treat this as a touch device at all (isMobileApp() in
// androidBridge.ts falls back to touch support when there's no native Android bridge), and it's
// what makes Chromium deliver the CDP touch events above to the page as real touches.
test.describe('with touch emulation', () => {
  test.use({ hasTouch: true })

  test('a one-finger drag scrolls back through the scrollback and back to the bottom', async ({ page }) => {
    const hostName = 'touch scroll test host'
    await connect(page, hostName)

    // 400 lines of pure line numbers: more scrollback than fits, and every screen of it says
    // exactly where in the buffer it is.
    await page.keyboard.type('seq 1 400')
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain('400')
    }).toPass({ timeout: 10_000 })

    const atBottom = firstVisibleNumber(await terminalText(page))
    expect(atBottom).toBeGreaterThan(1)

    // Finger down the screen = the content follows it = earlier lines come into view.
    await swipe(page, 300)
    const afterScrollBack = firstVisibleNumber(await terminalText(page))
    expect(afterScrollBack).toBeLessThan(atBottom)

    // ...and back the other way returns to where it started.
    await swipe(page, -300)
    expect(firstVisibleNumber(await terminalText(page))).toBe(atBottom)

    await cleanup(page, hostName)
  })

  test('a long press selects the word under the finger and Copy puts it on the clipboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const hostName = 'touch select test host'
    const marker = `touchmarker${Date.now()}`
    await connect(page, hostName)

    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(marker)
    }).toPass({ timeout: 10_000 })

    const target = await centreOf(page, marker)
    await longPress(page, target.x, target.y)

    const copy = page.getByRole('button', { name: 'Copy', exact: true })
    await expect(copy).toBeVisible()

    // Anchored to what's selected rather than parked in a corner: immediately above or below the
    // word it came from (whichever side there was room on), roughly over it.
    const copyBox = (await copy.boundingBox())!
    expect(Math.abs(copyBox.y + copyBox.height / 2 - target.y)).toBeLessThan(60)
    expect(Math.abs(copyBox.x + copyBox.width / 2 - target.x)).toBeLessThan(target.box.width)

    await copy.click()
    await expect(copy).toBeHidden()

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(marker)

    await cleanup(page, hostName)
  })

  test('dragging on from a long press extends the selection across lines', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const hostName = 'touch drag select test host'
    const stamp = Date.now()
    const [first, second, third] = [`alpha${stamp}`, `beta${stamp}`, `gamma${stamp}`]
    await connect(page, hostName)

    // Three markers, one per line, so each is a row of its own to aim at.
    await page.keyboard.type(`printf '%s\\n' ${first} ${second} ${third}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(third)
    }).toPass({ timeout: 10_000 })

    const start = await centreOf(page, first)
    const end = await centreOf(page, third)
    // Past the last character rather than onto it: the cell under the finger is where the
    // selection ends, so stopping on the final "a" would leave it out.
    await longPress(page, start.x, start.y, { x: end.box.x + end.box.width + 4, y: end.y })

    const copy = page.getByRole('button', { name: 'Copy', exact: true })
    await expect(copy).toBeVisible()
    await copy.click()

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied.split('\n').map((line) => line.trim())).toEqual([first, second, third])

    await cleanup(page, hostName)
  })

  test('a tap dismisses the selection instead of leaving it and its Copy button behind', async ({ page }) => {
    const hostName = 'touch dismiss test host'
    const marker = `dismissmarker${Date.now()}`
    await connect(page, hostName)

    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(await terminalText(page)).toContain(marker)
    }).toPass({ timeout: 10_000 })

    const target = await centreOf(page, marker)
    await longPress(page, target.x, target.y)
    const copy = page.getByRole('button', { name: 'Copy', exact: true })
    await expect(copy).toBeVisible()

    // A plain tap somewhere else in the terminal - not a second long press.
    const touch = await finger(page)
    await touch.down(target.x, target.y + 60)
    await touch.up()
    await expect(copy).toBeHidden()

    await cleanup(page, hostName)
  })

  test('a drag in a full-screen app scrolls it, since there is no scrollback to move through', async ({
    page,
  }) => {
    const hostName = 'touch altbuffer scroll test host'
    await connect(page, hostName)

    // nano takes over the alternate screen, where there is no scrollback by definition - so the
    // drag can only move anything if it reaches the application itself as cursor keys, which is
    // what a wheel does on a desktop. Read-only (-v) so a stray keystroke can't edit the file.
    await page.keyboard.type('seq 1 400 > /tmp/touchscroll.txt && nano -v /tmp/touchscroll.txt')
    await page.keyboard.press('Enter')
    await expect(async () => {
      expect(firstVisibleNumber(await terminalText(page))).toBe(1)
    }).toPass({ timeout: 15_000 })

    // Finger up the screen = further into the file. Several drags: the cursor has to walk past
    // the bottom row before nano scrolls the view at all.
    await expect(async () => {
      await swipe(page, -200)
      expect(firstVisibleNumber(await terminalText(page))).toBeGreaterThan(1)
    }).toPass({ timeout: 15_000 })

    await page.keyboard.press('Control+x')
    await expect(async () => {
      expect(await terminalText(page)).toContain('touchscroll.txt')
    }).toPass({ timeout: 10_000 })
    await cleanup(page, hostName)
  })
})
