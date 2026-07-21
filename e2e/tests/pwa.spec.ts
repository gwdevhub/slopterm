import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

test('the app is installable as a PWA', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  // Service worker must actually register and activate, not just attempt to. `ready`
  // resolves once there's an active worker, but its `state` string can still read
  // "activating" for a tick after that (a real, if narrow, race) - poll briefly instead
  // of asserting on the very first read.
  await expect(async () => {
    const swState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      return registration.active?.state
    })
    expect(swState).toBe('activated')
  }).toPass({ timeout: 5_000 })

  // The manifest link must be present and resolve to valid, correctly-shaped JSON.
  const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href')
  expect(manifestHref).toBe('/manifest.webmanifest')
  const manifest = await page.evaluate(async (href) => {
    const res = await fetch(href as string)
    return res.json()
  }, manifestHref)
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2)

  // The authoritative check: ask Chromium itself, via CDP, whether it considers this
  // page installable - not just inferring it indirectly from the presence of a manifest
  // and service worker.
  const cdp = await page.context().newCDPSession(page)
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
  expect(installabilityErrors).toEqual([])
})
