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

test.use({ hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' })

test('Android edits reach the shell once, before space, without stale composition overlays', async ({ page }) => {
  const name = 'Android single-owner input test'
  await page.addInitScript(() => {
    ;(window as unknown as { SloptermAndroid: unknown }).SloptermAndroid = {
      finishComposing() {
        const textarea = document.activeElement
        setTimeout(() => textarea?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })), 20)
      },
    }
  })
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await page.click('button:has-text("New host")')
  await page.fill('#name', name)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  await page.getByRole('button', { name: `SSH to ${name}` }).click()
  const rows = page.locator('.xterm-rows.xterm-focus')
  await expect(rows).toContainText('Welcome to OpenSSH Server', { timeout: 15_000 })

  try {
    await page.keyboard.type('printf "%s\\n" ')
    await expect(page.locator('.xterm-helper-textarea:focus')).toHaveValue('')
    await page.evaluate(() => {
      const textarea = document.activeElement as HTMLTextAreaElement
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      for (const value of ['p', 'ph', 'php', 'php-', 'php-z', 'php-zt', 'php-zts']) {
        textarea.value = value
        textarea.dispatchEvent(new InputEvent('input', {
          data: value, inputType: 'insertCompositionText', isComposing: true, bubbles: true,
        }))
      }
    })
    // Assert while the IME still owns the word: neither a space nor end is needed.
    await expect(rows).toContainText('php-zts')
    await expect(rows).not.toContainText('php-zts-zts')
    await expect(page.locator('.composition-view.active, .composition-echo')).toHaveCount(0)
    await page.evaluate(() => {
      const textarea = document.activeElement as HTMLTextAreaElement
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: 'zts', bubbles: true }))
      textarea.dispatchEvent(new InputEvent('input', {
        data: 'php-zts', inputType: 'insertText', isComposing: false, bubbles: true,
      }))
    })
    await page.keyboard.press('Enter')
    await expect(rows).toContainText(/php-zts\s+php-zts/)

    await page.keyboard.type('printf TAILCALL')
    await page.keyboard.press('Enter')
    await expect(rows).toContainText('TAILCALL')
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(rows).toContainText('/home/')
    await expect(rows).not.toContainText('pwdILCALL')
    await expect(page.locator('.composition-view.active, .composition-echo')).toHaveCount(0)
  } finally {
    await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`)
    await gotoSection(page, 'Hosts')
    await deleteHost(page, name)
  }
})
