import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// Drives a real left-button press-move-move-release across the two given elements' centres,
// the same motion an accidental drag makes. Two intermediate moves (not one straight jump)
// so the browser actually runs selection extension between the endpoints rather than
// treating it as a single click.
async function dragBetween(page: Page, from: string, to: string) {
  const start = await page.getByText(from, { exact: true }).first().boundingBox()
  const end = await page.getByText(to, { exact: true }).first().boundingBox()
  if (!start || !end) throw new Error(`could not locate drag endpoints "${from}" / "${to}"`)
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2, end.y + end.height / 2, { steps: 5 })
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 5 })
  await page.mouse.up()
}

// The app is a chromeless desktop window, so an accidental left-click drag across its chrome
// (nav rail, tab strip, title bar, host cards, dividers) must NOT smear a text selection the
// way a browser would - that reads as "the web leaking through" (issue #61). Selection is
// only meant to work inside real content: the terminal (xterm's own SelectionService, see
// terminal-copy.spec.ts) and text-entry fields.
test('dragging across the nav rail chrome does not select its text', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await ensureVaultUnlocked(page)

  // The sidebar nav labels are ordinary text nodes stacked vertically - exactly what a
  // browser would happily select across on a downward drag if user-select weren't off.
  await dragBetween(page, 'Hosts', 'Logs')

  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selection).toBe('')
})

// The flip side of the guard above: turning selection off globally must not also disable it
// on the surfaces where it's the whole point. Text-entry fields opt back in (they're the
// browser-testable stand-in for the terminal, whose own copy/selection is covered by
// terminal-copy.spec.ts and rides xterm's buffer, not the native selection API).
test('text in an input field can still be selected', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  const value = 'selectable-host-name'
  await page.fill('#name', value)

  const nameField = page.locator('#name')
  await nameField.selectText()

  const selectedInField = await nameField.evaluate((el: HTMLInputElement) =>
    el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
  )
  expect(selectedInField).toBe(value)
})
