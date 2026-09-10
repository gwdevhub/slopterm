import { test, expect, type Page } from '@playwright/test'
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

function terminalText(page: Page) {
  return page.locator('.xterm-rows:visible').innerText()
}

async function connect(page: Page, hostName: string) {
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)

  await page.click('button:has-text("New host")')
  await page.fill('#name', hostName)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await expect(page.getByText(hostName)).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: `SSH to ${hostName}` }).click()
  await expect(page.locator('.xterm-rows:visible')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
}

// Regression test for the "output caps at 80 columns" bug: the frontend now posts the fitted
// size to /api/ssh/{id}/resize, so a wide viewport must report well over 80 columns.
test('the remote PTY width matches the (wide) window, not the default 80 columns', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  const hostName = 'pty-width test host'
  await connect(page, hostName)

  // `stty size` is busybox-portable (the Alpine test image has no terminfo); the PTYSIZE
  // marker digits only appear in the output, never the echoed command line.
  await page.keyboard.type('printf "PTYSIZE=%s\\n" "$(stty size)"')
  await page.keyboard.press('Enter')

  let cols = 0
  await expect(async () => {
    const text = await terminalText(page)
    // "PTYSIZE=<rows> <cols>" - the last match is the command's output, not its echo.
    const matches = [...text.matchAll(/PTYSIZE=\d+ (\d+)/g)]
    expect(matches.length).toBeGreaterThan(0)
    cols = Number(matches[matches.length - 1][1])
    expect(cols).toBeGreaterThan(80)
  }).toPass({ timeout: 10_000 })

  await cleanup(page, hostName)
})

async function cleanup(page: Page, hostName: string) {
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, hostName)
}
