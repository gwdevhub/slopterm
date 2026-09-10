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

function terminalText(page: import('@playwright/test').Page) {
  // Every open tab's terminal stays mounted (that's the point of issue #9), so there can
  // be more than one .xterm-rows in the DOM at once - scope to whichever is visible.
  return page.locator('.xterm-rows:visible').innerText()
}

// There's no "+"/"New tab" button anymore (see TabBar.tsx) - every session starts from a
// host card's "SSH" button, so this always navigates back to Hosts first.
async function openTab(page: import('@playwright/test').Page) {
  await gotoSection(page, 'Hosts')
  await page.getByRole('button', { name: 'SSH to tabs test host' }).click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })
}

test('two concurrent tabs keep separate live sessions when switching between them', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'tabs test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('tabs test host')).toBeVisible({ timeout: 10_000 })

  await openTab(page)
  const markerA = `TAB_A_${Date.now()}`
  await page.keyboard.type(`echo ${markerA}`)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await terminalText(page)).toContain(markerA)
  }).toPass({ timeout: 10_000 })

  // Open a second, independent connection to the same host - the tab bar should now
  // show two tabs.
  await openTab(page)
  const markerB = `TAB_B_${Date.now()}`
  await page.keyboard.type(`echo ${markerB}`)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await terminalText(page)).toContain(markerB)
  }).toPass({ timeout: 10_000 })

  // Switched back, the first tab's output must still be there and the second's must not
  // leak. Matched by accessible name (label lives in a nested <span>); .first() skips "Close ...".
  const tabs = page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}` })
  await tabs.first().click()
  await expect(async () => {
    const text = await terminalText(page)
    expect(text).toContain(markerA)
    expect(text).not.toContain(markerB)
  }).toPass({ timeout: 5_000 })

  // Prove the first tab's session is still genuinely alive, not just showing stale
  // buffered text - run a fresh command and see it arrive live.
  const markerA2 = `TAB_A_LIVE_${Date.now()}`
  await page.keyboard.type(`echo ${markerA2}`)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await terminalText(page)).toContain(markerA2)
  }).toPass({ timeout: 10_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await expect(async () => {
    const text = await terminalText(page)
    expect(text).toContain(markerB)
  }).toPass({ timeout: 5_000 })

  const markerB2 = `TAB_B_LIVE_${Date.now()}`
  await page.keyboard.type(`echo ${markerB2}`)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await terminalText(page)).toContain(markerB2)
  }).toPass({ timeout: 10_000 })

  // Clean up the saved host - other spec files (e.g. vault.spec.ts) assert "No saved
  // hosts yet." against this same shared vault, so anything created here must not leak
  // past this test.
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'tabs test host')
})

test('switching away from a tab leaves its PTY size alone instead of shrinking it to a sliver', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'tabs test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('tabs test host')).toBeVisible({ timeout: 10_000 })

  await openTab(page)
  await openTab(page)

  // Switching away used to resize the remote PTY to a sliver (inactive tab reports 0x0, and
  // FitAddon floors its proposal), whose SIGWINCH redraw set the background-tab activity flag.
  const resizes: { cols: number; rows: number }[] = []
  page.on('request', (request) => {
    if (!/\/api\/ssh\/[^/]+\/resize$/.test(new URL(request.url()).pathname)) return
    try {
      resizes.push(JSON.parse(request.postData() ?? '{}'))
    } catch {
      // A resize we can't parse isn't evidence of anything - ignore it.
    }
  })

  const tabs = page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}` })
  await tabs.first().click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 10_000 })
  // Comfortably past the 75ms resize debounce, so a resize that was going to happen has.
  await page.waitForTimeout(1_000)

  // Any resize at all here would be suspect, but the assertion is on the thing that actually
  // broke: nobody gets told the terminal is now two cells wide.
  expect(resizes.filter((size) => size.cols < 20 || size.rows < 5)).toEqual([])

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'tabs test host')
})

test('a tab can be renamed inline and the new name survives a restart', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'rename test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('rename test host')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await page.getByRole('button', { name: 'SSH to rename test host' }).click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  const defaultLabel = `${ctx.sshUsername}@${ctx.sshHost}`
  await page.getByRole('button', { name: defaultLabel, exact: true }).dblclick()
  const renameField = page.getByRole('textbox', { name: `Rename ${defaultLabel}` })
  await expect(renameField).toBeVisible()
  await renameField.fill('my prod box')
  await renameField.press('Enter')

  await expect(page.getByRole('button', { name: 'my prod box', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: defaultLabel, exact: true })).toHaveCount(0)

  // The rename is persisted like any other tab state, so it must come back after a
  // restart rather than reverting to user@host.
  await page.goto(ctx.baseUrl)
  await expect(page.getByRole('button', { name: 'my prod box', exact: true })).toBeVisible({ timeout: 15_000 })

  // Wait for reconnect before closing: closing a still-'connecting' tab skips the confirm
  // dialog closeTab() clicks, so it would hang.
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  // Clean up (shared vault - see the first test); the Close button is keyed off the custom label.
  await closeTab(page, 'my prod box')
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'rename test host')
})

test('Ctrl+T duplicates the active tab into a new tab on the same host', async ({ page }) => {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', 'ctrl-t test host')
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText('ctrl-t test host')).toBeVisible({ timeout: 10_000 })

  await gotoSection(page, 'Hosts')
  await page.getByRole('button', { name: 'SSH to ctrl-t test host' }).click()
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  // exact: true excludes each tab's neighboring "Close {label}" button, which shares the label.
  const tabButton = page.getByRole('button', { name: `${ctx.sshUsername}@${ctx.sshHost}`, exact: true })
  await expect(tabButton).toHaveCount(1)

  await page.keyboard.press('Control+t')
  await expect(tabButton).toHaveCount(2, { timeout: 15_000 })
  await expect(async () => {
    expect(await terminalText(page)).toContain('Welcome to OpenSSH Server')
  }).toPass({ timeout: 15_000 })

  // Prove the new tab is a live, independent session - a marker typed here must land in
  // it and not be a stale echo of the first tab.
  const marker = `CTRL_T_${Date.now()}`
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect(async () => {
    expect(await terminalText(page)).toContain(marker)
  }).toPass({ timeout: 10_000 })

  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, 'ctrl-t test host')
})
