import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// API-level only: the toggle itself is rendered behind isMobileApp(), since the keep-alive
// notification it controls exists on Android and nowhere else (see SessionKeepAliveService).
// What's testable here is the setting it round-trips through - that it starts off, persists,
// and comes back on the shared settings object the app reads at startup.
test('"badge the app icon" defaults to off and round-trips through /api/settings', async ({ page }) => {
  await page.goto(ctx.baseUrl)

  const before = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).sessionNotificationBadge)
  expect(before).toBe(false)

  const on = await page.evaluate(async () => {
    const res = await fetch('/api/settings/session-notification-badge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    return (await res.json()).sessionNotificationBadge
  })
  expect(on).toBe(true)

  const persisted = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).sessionNotificationBadge)
  expect(persisted).toBe(true)

  // Back off, restoring the default the rest of the suite starts from.
  const off = await page.evaluate(async () => {
    const res = await fetch('/api/settings/session-notification-badge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    return (await res.json()).sessionNotificationBadge
  })
  expect(off).toBe(false)
})
