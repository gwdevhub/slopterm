import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deleteHost, ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

async function saveHost(page: import('@playwright/test').Page, name: string, group?: string) {
  await page.click('button:has-text("New host")')
  await page.fill('#name', name)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  if (group) await page.fill('#group', group)
  await page.click('button:has-text("Save host")')
}

test('hosts sharing a group collapse into one folder card that expands to show its members', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  const groupName = `e2e test group ${Date.now()}`
  // A lone host with a group assigned still shows as its own individual card - a "group"
  // of one isn't worth collapsing into a folder.
  await saveHost(page, 'group member A', groupName)
  await expect(page.getByText('group member A')).toBeVisible({ timeout: 10_000 })
  await saveHost(page, 'group member B', groupName)

  // Once a second host joins, the two individual hosts collapse into a single group
  // folder card summarizing both instead of showing as their own cards.
  await expect(page.getByText(groupName)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('2 hosts')).toBeVisible()
  await expect(page.getByText('group member A', { exact: true })).not.toBeVisible()
  await expect(page.getByText('group member B', { exact: true })).not.toBeVisible()

  // Expanding the group reveals both members as normal cards, plus a way back out.
  await page.getByText(groupName).click()
  await expect(page.getByText('group member A')).toBeVisible()
  await expect(page.getByText('group member B')).toBeVisible()
  await expect(page.getByText(groupName)).not.toBeVisible()

  await page.getByRole('button', { name: 'All hosts' }).click()
  await expect(page.getByText(groupName)).toBeVisible()
  await expect(page.getByText('group member A', { exact: true })).not.toBeVisible()

  // Searching flattens groups entirely - a member should be findable directly without
  // having to open the group first.
  await page.fill('input[placeholder="Find a host or ssh user@hostname…"]', 'group member A')
  await expect(page.getByText('group member A')).toBeVisible()
  await expect(page.getByText(groupName)).not.toBeVisible()
  await page.fill('input[placeholder="Find a host or ssh user@hostname…"]', '')

  // Clean up: open the group, delete both members (editing each back out of the group
  // first isn't necessary - deleting removes them from the grid entirely).
  await page.getByText(groupName).click()
  await deleteHost(page, 'group member A')
  await deleteHost(page, 'group member B')
  await expect(page.getByText('No saved hosts yet.')).toBeVisible({ timeout: 10_000 })
})
