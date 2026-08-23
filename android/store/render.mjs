// Renders feature-graphic.html to feature-graphic.png at exactly 1024x500 - the size Google
// Play requires for a feature graphic, which it rejects outright if it is off by a pixel.
// Uses the Chromium that e2e/'s Playwright install already provides; no extra dependency and
// no image toolchain (ImageMagick/rsvg) needed. Run from this directory:
//   node render.mjs
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 })
await page.goto(new URL('./feature-graphic.html', import.meta.url).href)
// Give the SVG mark and its blur filters a frame to paint before capturing.
await page.waitForTimeout(400)
await page.screenshot({ path: new URL('./feature-graphic.png', import.meta.url).pathname })
await browser.close()
