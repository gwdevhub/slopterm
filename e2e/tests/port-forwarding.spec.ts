import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// *Starting* a forward needs AllowTcpForwarding (the shared sshd has it off) and is covered by
// the backend functional test; here we prove the section renders and rule CRUD works.
test('port forwarding: create a rule through the section and see it listed', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  // A forward tunnels through a saved host - seed one (and remember its id for cleanup).
  const hostId = await page.evaluate(async () => {
    const res = await fetch('/api/vault/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'pf-e2e-host',
        address: 'example.com',
        port: 22,
        credentials: [{ id: crypto.randomUUID(), kind: 'password', username: 'u', secret: 'p' }],
      }),
    })
    return (await res.json()).id as string
  })

  await gotoSection(page, 'Port Forwarding')
  // No heading - it's the Hosts-style toolbar + card grid (see CardGrid), so the "New port
  // forward" button confirms it rendered; 10s like the suite's other post-navigation waits.
  await expect(page.getByRole('button', { name: 'New port forward' })).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'New port forward' }).click()
  await page.selectOption('#pf-host', { label: 'pf-e2e-host' })
  await page.fill('#pf-bind-port', '15080')
  await page.fill('#pf-dest-addr', '127.0.0.1')
  await page.fill('#pf-dest-port', '80')
  await page.fill('#pf-desc', 'pf-e2e-rule')
  await page.getByRole('button', { name: 'Add forward' }).click()

  const row = page.locator('li', { hasText: 'pf-e2e-rule' })
  await expect(row).toBeVisible()
  await expect(row.getByText(/local 127\.0\.0\.1:15080/)).toBeVisible()
  await expect(row.getByText(/via pf-e2e-host/)).toBeVisible()
  await expect(row.getByRole('button', { name: 'Start', exact: true })).toBeVisible()

  // Clean up so the shared suite vault is left as we found it.
  await row.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('li', { hasText: 'pf-e2e-rule' })).toHaveCount(0)
  await page.evaluate(async (id) => { await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' }) }, hostId)
})
