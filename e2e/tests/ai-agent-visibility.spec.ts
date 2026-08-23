import { test, expect } from '@playwright/test'
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

// Deliberately unreachable, like the collections specs' WebDAV URL: the bar's existence is
// decided by "is an endpoint configured", not by whether that endpoint answers, and this test
// is about exactly that distinction.
const UNREACHABLE_AI = 'http://127.0.0.1:9/v1'

// The AI agent is opt-in: an SSH client shouldn't carry a bar for a feature that can't run.
// With no endpoint set - the state a fresh install is in - a terminal tab has no AI strip at
// all, and entering a URL brings it into being without a reload.
test('the AI agent bar appears only once an endpoint is configured', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  // Whatever an earlier spec (or run) left in Settings, start from "no endpoint".
  await gotoSection(page, 'Settings')
  await page.fill('#ai-base-url', '')
  await page.getByRole('button', { name: 'Save AI settings' }).click()
  await expect(page.getByText('Off - no server URL set', { exact: false })).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await page.click('button:has-text("New host")')
  await page.fill('#name', 'ai bar test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('ai bar test host')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'SSH to ai bar test host' }).click()
  await expect(async () => {
    expect(await page.locator('.xterm-rows.xterm-focus').innerText()).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  // The bar is rendered asynchronously either way, so "not visible" needs a beat to mean
  // anything - assert it after the terminal has already proven the tab is fully up.
  await expect(page.getByRole('button', { name: 'AI agent' })).toHaveCount(0)

  // Setting a URL brings the bar into existence on the tab that is already open: the terminal
  // tabs listen for the change rather than waiting for a reload.
  await gotoSection(page, 'Settings')
  await page.fill('#ai-base-url', UNREACHABLE_AI)
  await page.getByRole('button', { name: 'Save AI settings' }).click()
  await expect(page.getByText('Off - no server URL set', { exact: false })).not.toBeVisible({ timeout: 10_000 })

  // Back to the tab: opening a section deselects it (handleSelectSection clears the active
  // tab), and the tab strip's own label button is what selects it again. `.first()` because
  // its "Close <label>" sibling matches the same substring, and the label comes first.
  await page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}` }).first().click()
  await expect(page.getByRole('button', { name: 'AI agent' })).toBeVisible({ timeout: 10_000 })

  // Put the setting back so no later spec inherits an AI endpoint it didn't ask for.
  await gotoSection(page, 'Settings')
  await page.fill('#ai-base-url', '')
  await page.getByRole('button', { name: 'Save AI settings' }).click()
  await expect(page.getByText('Off - no server URL set', { exact: false })).toBeVisible({ timeout: 10_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'ai bar test host')
})
