import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

// Exercises the Port Forwarding section's rendering + rule CRUD through the real UI. Actually
// *starting* a forward needs a server with AllowTcpForwarding on (the shared e2e sshd has it
// off), so the live tunnel is covered by the backend functional test instead; here we prove
// the section renders, the form creates a rule tunnelling through a saved host, and it's
// listed with the right mapping and controls.
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
  await expect(page.getByRole('heading', { name: 'Port Forwarding' })).toBeVisible()

  // Add a local forward through the form (opened from the "New port forward" button).
  await page.getByRole('button', { name: 'New port forward' }).click()
  await page.selectOption('#pf-host', { label: 'pf-e2e-host' })
  await page.fill('#pf-bind-port', '15080')
  await page.fill('#pf-dest-addr', '127.0.0.1')
  await page.fill('#pf-dest-port', '80')
  await page.fill('#pf-desc', 'pf-e2e-rule')
  await page.getByRole('button', { name: 'Add forward' }).click()

  // It shows up with its mapping and a Start control (inactive until started).
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
