import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

test('"show hosts from ~/.ssh/config" defaults to off, toggles + persists, and lists the fixture alias', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  // Off by default - the Hosts screen shows nothing from the fixture config yet (no other
  // test file touches this setting).
  await expect(page.getByText('From ~/.ssh/config')).not.toBeVisible()

  await gotoSection(page, 'Settings')
  await expect(page.getByText('Loading settings')).not.toBeVisible({ timeout: 10_000 })

  const toggle = page.getByRole('button', { name: 'Show hosts from ~/.ssh/config' })
  await expect(toggle).toHaveText('Off')
  const before = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).showSshConfigHosts)
  expect(before).toBe(false)

  await toggle.click()
  await expect(toggle).toHaveText('On')

  // The fixture alias (global-setup.ts's ssh_config, no IdentityFile) now shows as a
  // read-only card: connectable buttons disabled, no Edit button (nothing to edit).
  await gotoSection(page, 'Hosts')
  await expect(page.getByText('From ~/.ssh/config')).toBeVisible()
  await expect(page.getByText('e2e-ssh-config-host')).toBeVisible()
  await expect(page.getByRole('button', { name: 'SSH to e2e-ssh-config-host' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'SFTP to e2e-ssh-config-host' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Edit e2e-ssh-config-host' })).toHaveCount(0)

  // ...and turning it back off both hides the section and restores the shared default the
  // rest of the suite expects.
  await gotoSection(page, 'Settings')
  await toggle.click()
  await expect(toggle).toHaveText('Off')
  const afterOff = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).showSshConfigHosts)
  expect(afterOff).toBe(false)

  await gotoSection(page, 'Hosts')
  await expect(page.getByText('From ~/.ssh/config')).not.toBeVisible()
})
