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

// Uses a saved Host's "SSH" button rather than Quick Connect - these tests care about the
// terminal itself, not the connect flow, so a saved host keeps each test's setup identical
// regardless of which entry point was used to get there.
async function connect(page: Page, hostName: string) {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', hostName)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText(hostName)).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: `SSH to ${hostName}` }).click()
  await expect(page.locator('.xterm-rows')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
}

// Closes the tab and deletes the saved host - other spec files assert "No saved hosts
// yet." against this same shared vault, so anything created here must not leak past
// whichever test created it.
async function cleanup(page: Page, hostName: string) {
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, hostName)
}

// Double-clicks the given (already-visible, on-screen-by-itself) word inside the
// terminal - xterm.js's own SelectionService resolves this to a word-boundary selection
// from real mouse coordinates, independent of the getSelection() API used elsewhere.
// `.xterm-rows` is xterm's screen-reader-only text mirror (handy for reading rendered
// output, per the other e2e specs) - it sits *behind* `.xterm-screen`, the actual layer
// that receives pointer events, so clicking the row locator directly never lands.
// Reading its bounding box for the coordinates and dispatching a raw mouse dblclick
// there hits the real interactive layer at the right spot instead.
async function selectWord(page: Page, word: string) {
  const box = await page.locator('.xterm-rows').getByText(word, { exact: true }).boundingBox()
  if (!box) throw new Error(`could not locate "${word}" in the terminal to select`)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
}

test('ctrl+c copies the selection and clears it, so a second ctrl+c interrupts instead of copying again', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const hostName = 'ctrlc copy test host'
  const marker = `copymarker${Date.now()}`
  await connect(page, hostName)

  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 10_000 })

  await selectWord(page, marker)
  await page.keyboard.press('Control+c')
  await expect(async () => {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(marker)
  }).toPass({ timeout: 5_000 })

  // The selection should now be cleared. A second Ctrl+C with nothing selected must act
  // as the interrupt signal instead of copying again - overwrite the clipboard with a
  // sentinel first so an (incorrect) second copy would be observable.
  await page.evaluate(() => navigator.clipboard.writeText('sentinel-value'))
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('sentinel-value')

  await cleanup(page, hostName)
})

test('ctrl+shift+c copies the selection without clearing it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const hostName = 'ctrl-shift-c test host'
  const marker = `shiftcopymarker${Date.now()}`
  await connect(page, hostName)

  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 10_000 })

  await selectWord(page, marker)
  await page.keyboard.press('Control+Shift+c')
  await expect(async () => {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(marker)
  }).toPass({ timeout: 5_000 })

  // The selection must have survived: overwrite the clipboard, then a plain Ctrl+C
  // should find the same selection still active and copy it again (rather than the
  // selection being gone and Ctrl+C instead sending an interrupt).
  await page.evaluate(() => navigator.clipboard.writeText('sentinel-value'))
  await page.keyboard.press('Control+c')
  await expect(async () => {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(marker)
  }).toPass({ timeout: 5_000 })

  await cleanup(page, hostName)
})

test('ctrl+c with no selection sends an interrupt to the remote process', async ({ page }) => {
  const hostName = 'ctrlc interrupt test host'
  await connect(page, hostName)

  await page.keyboard.type('sleep 20')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+c')

  const marker = `interruptmarker${Date.now()}`
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  // If the interrupt hadn't actually reached the shell, this would only appear after the
  // full 20s sleep finishes - bounding the wait well below that makes a swallowed
  // interrupt a hard failure rather than a slow pass.
  await expect(page.locator('.xterm-rows')).toContainText(marker, { timeout: 5_000 })

  await cleanup(page, hostName)
})
