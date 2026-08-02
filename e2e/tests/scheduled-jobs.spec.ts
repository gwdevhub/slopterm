import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}

// Unlike the port-forwarding section (whose live path needs AllowTcpForwarding, which the
// shared e2e sshd has off), a scheduled job only needs an SSH exec channel - so this drives
// the whole feature for real: create a job through the form, run it against the disposable
// sshd, and assert its actual stdout comes back in the run history.
async function seedHost(page: Page, name: string) {
  return page.evaluate(
    async ([hostName, address, port, username, password]) => {
      const res = await fetch('/api/vault/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: hostName,
          address,
          port: Number(port),
          credentials: [{ id: crypto.randomUUID(), kind: 'password', username, secret: password }],
        }),
      })
      return (await res.json()).id as string
    },
    [name, ctx.sshHost, String(ctx.sshPort), ctx.sshUsername, ctx.sshPassword],
  )
}

async function openJobsSection(page: Page) {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await gotoSection(page, 'Scheduled Jobs')
  // The section is the Hosts-style toolbar + card grid (see CardGrid) with no heading, so
  // the "New job" button is what confirms it rendered. Explicit 10s like the suite's other
  // post-navigation waits - a first section render on a cold start can miss the default 5s.
  await expect(page.getByRole('button', { name: 'New job' })).toBeVisible({ timeout: 10_000 })
}

// Fills the new-job form. The schedule is left at its "every 60 minutes" default so nothing
// fires on its own mid-test - the run under test is the explicit "Run now" below.
async function createJob(page: Page, name: string, command: string) {
  await page.getByRole('button', { name: 'New job' }).click()
  await page.fill('#job-name', name)
  await page.selectOption('#job-host', { label: 'jobs-e2e-host' })
  await page.fill('#job-command', command)
  await page.getByRole('button', { name: 'Add job' }).click()
}

async function deleteJob(page: Page, name: string) {
  const card = page.locator('li', { hasText: name })
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('li', { hasText: name })).toHaveCount(0)
}

test('scheduled jobs: create a job, run it, and see its real output in the history', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  const hostId = await seedHost(page, 'jobs-e2e-host')

  await openJobsSection(page)

  // The best-effort caveat is a requirement of the feature, not decoration - a job that
  // quietly doesn't run while the app is closed is exactly what this has to disclose.
  await expect(page.getByText('Jobs only run while slopterm is open')).toBeVisible()

  await createJob(page, 'jobs-e2e-echo', 'echo hello-from-slopterm-job')

  const card = page.locator('li', { hasText: 'jobs-e2e-echo' })
  await expect(card).toBeVisible()
  await expect(card.getByText('echo hello-from-slopterm-job')).toBeVisible()
  await expect(card.getByText(/Every 1h on jobs-e2e-host/)).toBeVisible()

  // Run it for real against the disposable sshd, then read the run history back.
  await card.getByRole('button', { name: 'Run now' }).click()
  await card.getByRole('button', { name: 'History' }).click()

  // The outcome is lowercase in the DOM (it's CSS `capitalize` that title-cases it), so
  // match case-insensitively rather than against what the screenshot shows.
  const history = page.getByRole('dialog', { name: /run history/ })
  await expect(history.getByText(/^success$/i)).toBeVisible({ timeout: 20_000 })
  await expect(history.getByText('hello-from-slopterm-job')).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  // Disabling is a plain record edit (the scheduler notices by itself) - the card shows it.
  await card.getByRole('button', { name: 'Disable' }).click()
  await expect(card.getByText('Off')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Enable' })).toBeVisible()

  // Clean up so the shared suite vault is left as we found it.
  await deleteJob(page, 'jobs-e2e-echo')
  await page.evaluate(async (id) => { await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' }) }, hostId)
})

test('scheduled jobs: a non-zero exit is recorded as a failed run', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  const hostId = await seedHost(page, 'jobs-e2e-host')

  await openJobsSection(page)
  await createJob(page, 'jobs-e2e-failing', 'echo nearly; exit 3')

  const card = page.locator('li', { hasText: 'jobs-e2e-failing' })
  await card.getByRole('button', { name: 'Run now' }).click()
  await card.getByRole('button', { name: 'History' }).click()

  const history = page.getByRole('dialog', { name: /run history/ })
  await expect(history.getByText(/^failed$/i)).toBeVisible({ timeout: 20_000 })
  await expect(history.getByText(/exit 3/)).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  await deleteJob(page, 'jobs-e2e-failing')
  await page.evaluate(async (id) => { await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' }) }, hostId)
})

test('scheduled jobs: a cron schedule previews its next runs, rejects a bad expression, and saves', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  const hostId = await seedHost(page, 'jobs-e2e-host')

  await openJobsSection(page)
  await page.getByRole('button', { name: 'New job' }).click()
  await page.fill('#job-name', 'jobs-e2e-cron')
  await page.selectOption('#job-host', { label: 'jobs-e2e-host' })
  await page.fill('#job-command', 'true')
  await page.selectOption('#job-schedule', 'cron')

  // Nonsense first: the preview is the thing that tells you before you save, so it has to
  // say so on its own, without a submit.
  await page.fill('#job-cron', 'every tuesday please')
  await expect(page.getByText(/isn't a valid cron expression/)).toBeVisible({ timeout: 10_000 })

  // Parses, but matches no real date - a job that would sit there looking scheduled forever.
  await page.fill('#job-cron', '0 0 30 2 *')
  await expect(page.getByText(/never matches a real date/)).toBeVisible({ timeout: 10_000 })

  // A real expression resolves to actual instants. 03:00 on the 1st of each month is far
  // enough from any plausible test-run time that nothing fires during the suite.
  await page.fill('#job-cron', '0 3 1 * *')
  await expect(page.getByText(/^Next runs: /)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/isn't a valid cron expression/)).toHaveCount(0)

  await page.getByRole('button', { name: 'Add job' }).click()

  // The card shows the expression verbatim - deliberately not a prose translation.
  const card = page.locator('li', { hasText: 'jobs-e2e-cron' })
  await expect(card).toBeVisible()
  await expect(card.getByText('0 3 1 * * on jobs-e2e-host')).toBeVisible()
  // And the scheduler itself accepted it, i.e. it computed a real next-run time.
  await expect(card.getByText(/Next \d/)).toBeVisible({ timeout: 10_000 })

  await deleteJob(page, 'jobs-e2e-cron')
  await page.evaluate(async (id) => { await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' }) }, hostId)
})

test('scheduled jobs: the form surfaces a backend validation error', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  const hostId = await seedHost(page, 'jobs-e2e-host')

  await openJobsSection(page)
  await page.getByRole('button', { name: 'New job' }).click()
  await page.fill('#job-name', 'jobs-e2e-invalid')
  await page.selectOption('#job-host', { label: 'jobs-e2e-host' })
  // A bad regex is caught server-side (the command field's own `required` covers the empty
  // case client-side), so this proves the backend's validation reaches the user.
  await page.fill('#job-command', 'true')
  await page.fill('#job-failure-pattern', '([unclosed')
  await page.getByRole('button', { name: 'Add job' }).click()

  await expect(page.getByText(/failure pattern isn't a valid regular expression/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('li', { hasText: 'jobs-e2e-invalid' })).toHaveCount(0)

  await page.evaluate(async (id) => { await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' }) }, hostId)
})
