import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// The debug apphost's update result depends on live GitHub state, so this only asserts the
// section reaches *some* terminal state; the real download/swap flow is verified elsewhere.
test('Settings shows the Updates section and reaches a terminal state', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Settings')
  await ensureVaultUnlocked(page)

  await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible({ timeout: 10_000 })
  // Never clicked: which outcome appears depends on live network/repo state, and "Update now"
  // would kick off a real, destructive apply against this dev server.
  const button = page.getByRole('button', { name: /Checking…|Check now|Update now/ })
  await expect(button).toBeVisible({ timeout: 10_000 })
  await expect(button).toBeEnabled({ timeout: 15_000 })
  await expect(button).toHaveText(/Check now|Update now/)
  await expect(page.getByText('Checking for updates…')).not.toBeVisible()
})

test('saves and clears a GitHub token', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Settings')
  await ensureVaultUnlocked(page)

  await expect(page.getByText('No token is set yet.')).toBeVisible({ timeout: 10_000 })

  await page.fill('#github-token', 'ghp_fake_e2e_token')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('A token is currently set.')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByText('No token is set yet.')).toBeVisible({ timeout: 10_000 })
})
