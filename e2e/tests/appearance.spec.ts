import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// The Appearance screen writes semantic color tokens onto <html> as CSS custom properties,
// so changing the Accent color must re-theme every bg-indigo-* surface live; it also persists to localStorage.
test('changing the accent color re-themes the app and persists across reloads', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await gotoSection(page, 'Appearance')

  const navButton = page.getByRole('button', { name: 'Appearance', exact: true })
  await expect(navButton).toHaveCSS('background-color', 'rgb(79, 70, 229)')

  const accentHex = page.getByRole('textbox', { name: 'Accent hex' })
  await accentHex.fill('#ef4444')
  await expect(navButton).toHaveCSS('background-color', 'rgb(239, 68, 68)')

  // The saved accent must reapply on reload (localStorage), both to the theme and the field.
  await page.reload()
  await ensureVaultUnlocked(page)
  await gotoSection(page, 'Appearance')
  await expect(page.getByRole('textbox', { name: 'Accent hex' })).toHaveValue('#ef4444')
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toHaveCSS('background-color', 'rgb(239, 68, 68)')

  // Restore defaults so this shared-state test doesn't tint every later spec's screenshots.
  await page.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toHaveCSS('background-color', 'rgb(79, 70, 229)')
})

// Switching to Light swaps the whole neutral palette (the surface token backing bg-slate-900
// chrome and the root color-scheme), and Dark reverts it.
test('the Light theme applies a light palette and reverts on Dark', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await gotoSection(page, 'Appearance')

  const surface = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-surface').trim())
  const scheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)

  await page.getByRole('button', { name: 'Light', exact: true }).click()
  expect(await surface()).toBe('#ffffff')
  expect(await scheme()).toBe('light')

  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  expect(await surface()).toBe('#0f172a')
  expect(await scheme()).toBe('dark')
})
