import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// The title bar only renders inside the Photino desktop window (detected via
// window.external.sendMessage), so stand in a fake bridge that records wc:* commands.
test('desktop mode: title bar owns the window controls + the collapse/Settings hamburger', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __wc: string[]; __recv?: (m: string) => void; external: unknown }
    w.__wc = []
    w.external = {
      sendMessage: (message: string) => {
        w.__wc.push(message)
        // Mirror the backend: reply to the initial "ready" with the windowed state, and flip
        // to maximized when asked to maximize, so the glyph state-sync can be tested too.
        if (message === 'wc:ready') w.__recv?.('wc:restored')
        if (message === 'wc:max') w.__recv?.('wc:maximized')
      },
      receiveMessage: (callback: (m: string) => void) => {
        w.__recv = callback
      },
    }
  })

  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  for (const label of ['Menu', 'Minimize', 'Maximize', 'Close']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
  }

  await expect(page.getByRole('button', { name: /Collapse sidebar|Expand sidebar/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /Collapse sidebar/ })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // Window controls post the right bridge messages, and the maximize glyph tracks the state
  // echoed back (Maximize -> Restore once the host reports it maximized).
  await page.getByRole('button', { name: 'Minimize', exact: true }).click()
  await page.getByRole('button', { name: 'Maximize', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()

  const messages = await page.evaluate(() => (window as unknown as { __wc: string[] }).__wc)
  expect(messages).toContain('wc:ready')
  expect(messages).toContain('wc:min')
  expect(messages).toContain('wc:max')
})

// The desktop-only title bar must not leak into the browser experience: with no host bridge,
// there's no title bar and the sidebar keeps its own collapse toggle and Settings.
test('browser mode: no title bar; sidebar keeps its own collapse + Settings', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await expect(page.getByRole('button', { name: 'Minimize', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Collapse sidebar|Expand sidebar/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
})
