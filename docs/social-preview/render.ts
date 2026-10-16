// Renders index.html to social-preview.png (1280x640) with Playwright.
//
// Run from the repository root, with a Chromium that Playwright can drive:
//   deno run -A --no-lock docs/social-preview/render.ts [path to chromium]
// Without a path it uses the browser Playwright installed (`npx playwright install chromium`).
// --no-lock keeps this one-off tool out of the repository's deno.lock.

import { chromium } from "npm:playwright-core@1.56.1"

const here = new URL(".", import.meta.url)
const browser = await chromium.launch({ executablePath: Deno.args[0] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } })
  await page.goto(new URL("index.html", here).href)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: new URL("social-preview.png", here).pathname })
} finally {
  await browser.close()
}
