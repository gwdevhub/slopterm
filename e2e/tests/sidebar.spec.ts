import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

test('desktop sidebar collapses to icons-only and expands back', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  const nav = page.locator('nav')
  const expandedBox = await nav.boundingBox()

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  const collapsedBox = await nav.boundingBox()
  expect(collapsedBox!.width).toBeLessThan(expandedBox!.width)

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  const reExpandedBox = await nav.boundingBox()
  expect(reExpandedBox!.width).toBe(expandedBox!.width)
})

test('mobile menu overlay opens from a menu button, selects a section, and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(ctx.baseUrl)
  await ensureVaultUnlocked(page)

  // The desktop sidebar's own "Hosts" button is `display:none` at this width, so it's
  // excluded from the accessibility tree entirely - only the mobile menu button and
  // whatever section is currently showing should be reachable.
  await expect(page.getByRole('button', { name: 'Hosts', exact: true })).toBeHidden()
  await page.getByRole('button', { name: 'Open menu' }).click()

  await expect(page.getByRole('button', { name: 'Hosts', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keychain', exact: true }).click()

  // Selecting an option both navigates and closes the overlay in one action.
  await expect(page.getByText('No saved keys yet.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Keychain', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible()
})

test('nothing labeled "Quick Connect" exists anymore', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await expect(page.getByText('Quick Connect')).toHaveCount(0)
})
