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

// Same "connect a saved host and land in its SSH tab" setup terminal-copy.spec.ts uses -
// these tests care about the terminal itself, not the connect flow.
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
  await expect(page.locator('.xterm-rows')).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })
}

async function cleanup(page: Page, hostName: string) {
  await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
  await gotoSection(page, 'Hosts')
  await deleteHost(page, hostName)
}

// Simulates a screenshot-tool paste: the browser fires a native `paste` on xterm's helper
// textarea carrying an image File (no meaningful name of its own) and no text. TerminalView's
// listener must intercept it, upload the bytes over /api/ssh/upload, and never feed them into
// the shell as literal input. Dispatching a real ClipboardEvent with a DataTransfer is the
// closest faithful reproduction of what Snipping Tool / a browser image paste actually does -
// Playwright has no higher-level "paste a file" primitive.
async function pasteImage(page: Page, fileName: string, contents: string) {
  await page.evaluate(
    ({ fileName, contents }) => {
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      if (!textarea) throw new Error('xterm helper textarea not found')
      const dt = new DataTransfer()
      dt.items.add(new File([contents], fileName, { type: 'image/png' }))
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { fileName, contents },
  )
}

test('pasting an image into an SSH tab uploads it into the prompted directory and confirms', async ({ page }) => {
  const hostName = 'paste upload test host'
  await connect(page, hostName)

  // This shell (the openssh-server test container) doesn't emit OSC 7, so cwd is unknown and
  // the upload falls back to prompting for a destination. Answer it with the SSH login
  // directory (the container user's writable home, `/config` on lscr.io/linuxserver/openssh-server).
  page.once('dialog', (dialog) => void dialog.accept('/config'))

  const fileName = `pasted-${Date.now()}.png`
  const contents = `paste-upload-e2e-${Date.now()}`
  await pasteImage(page, fileName, contents)

  // The confirmation toast reports the exact remote path the bytes landed at - proves the
  // /api/ssh/upload round-trip (fresh one-shot SFTP write) actually succeeded, not just that
  // a request was dispatched.
  await expect(page.getByText(`Uploaded to /config/${fileName}`)).toBeVisible({ timeout: 15_000 })

  // And the paste must NOT have leaked into the shell as literal input - the file's textual
  // contents should never appear on the command line.
  await expect(page.locator('.xterm-rows')).not.toContainText(contents)

  await cleanup(page, hostName)
})
