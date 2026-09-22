import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as { baseUrl: string }

async function clickInjectedExternalLink(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const link = document.createElement('a')
    link.href = 'https://example.com/docs'
    link.target = '_blank'
    document.body.append(link)
    link.click()
  })
}

test('desktop app opens external links through its native host', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as { messages: string[]; external: unknown }
    host.messages = []
    host.external = {
      sendMessage: (message: string) => host.messages.push(message),
      receiveMessage: () => {},
    }
  })

  await page.goto(ctx.baseUrl)
  await clickInjectedExternalLink(page)

  const messages = await page.evaluate(() => (window as unknown as { messages: string[] }).messages)
  expect(messages).toContain('wc:open-external:"https://example.com/docs"')
})

test('Android app opens external links through its native host', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as { openedUrls: string[]; SloptermAndroid: unknown }
    host.openedUrls = []
    host.SloptermAndroid = {
      openExternal: (url: string) => host.openedUrls.push(url),
      saveFile: () => {},
      finishComposing: () => {},
    }
  })

  await page.goto(ctx.baseUrl)
  await clickInjectedExternalLink(page)

  const openedUrls = await page.evaluate(() => (window as unknown as { openedUrls: string[] }).openedUrls)
  expect(openedUrls).toEqual(['https://example.com/docs'])
})
