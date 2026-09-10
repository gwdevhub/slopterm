import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

test('the app is installable as a PWA', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  // `ready` resolves once there's an active worker, but its state can read "activating" for a
  // tick (a narrow race), so poll briefly instead of asserting on the first read.
  await expect(async () => {
    const swState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      return registration.active?.state
    })
    expect(swState).toBe('activated')
  }).toPass({ timeout: 5_000 })

  const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href')
  expect(manifestHref).toBe('/manifest.webmanifest')
  const manifest = await page.evaluate(async (href) => {
    const res = await fetch(href as string)
    return res.json()
  }, manifestHref)
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2)

  // The authoritative check: ask Chromium itself, via CDP, whether it considers the page
  // installable, rather than inferring from manifest + service worker.
  const cdp = await page.context().newCDPSession(page)
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
  expect(installabilityErrors).toEqual([])
})
