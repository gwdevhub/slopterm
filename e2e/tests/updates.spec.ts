import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// The e2e harness runs the server via `dotnet run` (see global-setup.ts) against a debug
// apphost, not a real published single-file exe - UpdateService.CheckAsync still hashes
// and checks *something* real (Environment.ProcessPath resolves to that debug apphost),
// which means this test's outcome depends on live network access to api.github.com and
// on gwdevhub/terminal's actual current state (its visibility, its latest release) -
// none of which this suite controls or should depend on for a deterministic pass/fail.
// So this only asserts the section renders and reaches *some* terminal state, not which
// one - the actual download/swap/relaunch flow (and every check/apply behavior that does
// depend on repo visibility/auth) is verified separately against a real published build
// and the real GitHub API/repo, see AGENTS.md's Self-update section.
test('Settings shows the Updates section and reaches a terminal state', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Settings')
  await ensureVaultUnlocked(page)

  await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Checking for updates…')).not.toBeVisible({ timeout: 15_000 })
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
