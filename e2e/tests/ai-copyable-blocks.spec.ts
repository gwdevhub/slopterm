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

test('assistant blocks copy exact text and report clipboard failures at mobile width', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { copiedBlocks: string[]; failCopy: boolean }
    state.copiedBlocks = []
    state.failCopy = false
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (state.failCopy) throw new Error('Clipboard blocked')
        state.copiedBlocks.push(text)
      },
    } })
  })
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: {
    configured: true, reachable: true, baseUrl: 'http://example.test/v1',
    models: ['test-model'], hasApiKey: false, unauthorized: false,
  } }))
  await page.routeWebSocket('**/ws/agent/*', (socket) => socket.send(JSON.stringify({
    type: 'history', messages: [{
      id: 'copy-test', role: 'assistant', mode: 'chat', activities: [],
      text: 'Copy this command:\n```sh\n  printf "hello"\n\n```\nOr this text:\n```text\n<script>literal text</script>\n```',
    }],
  })))

  const name = 'ai copyable blocks host'
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
  try {
    await page.getByRole('button', { name: `SSH to ${name}` }).click()
    await page.getByRole('button', { name: 'AI agent', exact: true }).click()
    // The shared section-navigation helper targets the desktop sidebar. Exercise
    // the message controls at phone width after setup, then restore it for cleanup.
    await page.setViewportSize({ width: 390, height: 844 })
    const copyButtons = page.getByRole('button', { name: 'Copy block', exact: true })
    await expect(copyButtons).toHaveCount(2)
    await expect(page.locator('pre code').last()).toHaveText('<script>literal text</script>\n')
    await copyButtons.first().click()
    await expect(page.getByRole('status').filter({ hasText: 'Copied!' })).toBeVisible()
    expect(await page.evaluate(() => (window as typeof window & { copiedBlocks: string[] }).copiedBlocks))
      .toEqual(['  printf "hello"\n\n'])
    await copyButtons.last().click()
    expect(await page.evaluate(() => (window as typeof window & { copiedBlocks: string[] }).copiedBlocks))
      .toEqual(['  printf "hello"\n\n', '<script>literal text</script>\n'])
    await page.evaluate(() => { (window as typeof window & { failCopy: boolean }).failCopy = true })
    await copyButtons.last().click()
    await expect(page.getByRole('status').filter({ hasText: 'Could not copy.' })).toBeVisible()
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 })
    await closeTab(page, `${ctx.sshUsername}@${ctx.sshHost}`, { first: true })
    await gotoSection(page, 'Hosts')
    await deleteHost(page, name)
  }
})
