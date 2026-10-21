/**
 * The browser half of the demo video: opens the OmniTools page the deploy just put online, finds
 * the QR code generator through the search box and types a link into it, like a person.
 *
 * ```bash
 * deno run -A browser.ts <url> <out dir>
 * ```
 *
 * It records with the DevTools screencast instead of Playwright's video: every frame arrives
 * with its own timestamp, so a loaded machine records fewer frames but never wrong timing. Writes
 * `<out dir>/browser/NNNNN.jpg`, `<out dir>/browser/frames.json` (each frame's time in seconds
 * from the start) and `<out dir>/browser/shots.json` (when each shot of the browser part starts
 * and ends). The frames are 1280x660 (a 1024x528 viewport at 125 %): encode.ts adds a 56 px address bar above it and the 84 px
 * caption band below it.
 *
 * @module
 */
import { chromium } from "npm:playwright@1.63.0"
import { join } from "@std/path"
import { clickLike, moveLike } from "./human-mouse.ts"

/** The frame size the encoder expects, in screen pixels. */
const WIDTH = 1280
const HEIGHT = 660
/** The page is drawn at 125 %, so its text stays readable when the clip plays small. */
const ZOOM = 1.25
/** The viewport in CSS pixels: what the page lays out in and the pointer moves in. */
const VIEW = { width: WIDTH / ZOOM, height: HEIGHT / ZOOM }
/** The link typed into the QR code generator. */
const LINK = "https://github.com/spy4x/rostok"

const [url, outDir] = Deno.args
if (!url || !outDir) throw new Error("usage: browser.ts <url> <out dir>")
const dir = join(outDir, "browser")
await Deno.mkdir(dir, { recursive: true })

const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: ZOOM,
    colorScheme: "dark",
    timezoneId: "Europe/Berlin",
    locale: "en-US",
  })
  const pointer = { x: 830, y: 450 }
  await context.addInitScript(`window.__demoPointerStart = ${JSON.stringify(pointer)}`)
  await context.addInitScript({ path: new URL("./pointer.js", import.meta.url).pathname })
  const page = await context.newPage()

  // Load the page off the record first. Let's Encrypt can still be finishing on the first
  // request, and Chromium sometimes aborts a first load while the network settles: three tries.
  for (let attempt = 1;; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
      break
    } catch (err) {
      if (attempt === 3) throw err
      await page.waitForTimeout(3000)
    }
  }
  const search = page.getByPlaceholder("Search all tools")
  await search.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(500)

  const cdp = await context.newCDPSession(page)
  // Frames are timed by their own timestamps, from the first frame's (t0). The shot marks use the
  // wall clock from the moment that first frame arrived (wall0): the two clocks differ, so only
  // their differences are compared.
  const frames: number[] = []
  let t0: number | undefined
  let wall0: number | undefined
  const writes: Promise<void>[] = []
  cdp.on("Page.screencastFrame", (f) => {
    // Acknowledge first: Chromium sends the next frame only after the ack.
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
    const t = f.metadata.timestamp ?? Date.now() / 1000
    t0 ??= t
    wall0 ??= Date.now() / 1000
    const n = frames.push(t - t0) - 1
    writes.push(
      Deno.writeFile(
        join(dir, `${String(n).padStart(5, "0")}.jpg`),
        Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)),
      ),
    )
  })
  const now = () => Date.now() / 1000 - (wall0 ?? Date.now() / 1000)
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1,
  })
  while (frames.length === 0) await page.waitForTimeout(20)
  const shots: { name: string; start: number; end: number }[] = []
  const shot = async (name: string, body: () => Promise<void>) => {
    const start = now()
    await body()
    shots.push({ name, start, end: now() })
  }

  await shot("live", async () => {
    await page.waitForTimeout(2500)
    await moveLike(page, pointer, { x: 610, y: 340 })
    await page.waitForTimeout(1200)
  })
  await shot("search", async () => {
    await clickLike(page, pointer, search, VIEW.height)
    await page.waitForTimeout(400)
    await page.keyboard.type("qr", { delay: 220 })
    const option = page.getByRole("option", { name: /QR Code Generator/ })
    await option.waitFor({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    await clickLike(page, pointer, option, VIEW.height)
    await page.waitForURL(/qr-code/, { timeout: 10_000 })
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(1500)
  })
  await shot("qr", async () => {
    // Bring the generated code and the link field into view together, smoothly: the code's
    // top edge goes to the top of the viewport, which leaves the field just above its bottom.
    // The field is clicked without clickLike, whose edge check would scroll the code away.
    const field = page.getByPlaceholder("https://example.com")
    const code = page.locator("img").filter({ visible: true }).nth(1)
    const top = (await code.boundingBox())?.y ?? 0
    await page.evaluate(`scrollBy({ top: ${Math.round(top - 8)}, behavior: "smooth" })`)
    await page.waitForTimeout(1500)
    const box = await field.boundingBox()
    if (!box || box.y + box.height > VIEW.height) throw new Error("the link field is off screen")
    await moveLike(page, pointer, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.waitForTimeout(200)
    await page.mouse.up()
    await page.waitForTimeout(200)
    await page.keyboard.press("ControlOrMeta+A")
    await page.waitForTimeout(500)
    await page.keyboard.type(LINK, { delay: 80 })
    await page.waitForTimeout(800)
    await moveLike(page, pointer, { x: pointer.x + 120, y: pointer.y + 50 })
    await page.waitForTimeout(3000)
  })

  await cdp.send("Page.stopScreencast")
  await Promise.all(writes)
  await Deno.writeTextFile(join(dir, "frames.json"), JSON.stringify(frames))
  await Deno.writeTextFile(join(dir, "shots.json"), JSON.stringify(shots, null, 2))
  console.log(`browser: ${frames.length} frames, ${shots.at(-1)?.end.toFixed(1)} s`)
  await context.close()
} finally {
  await browser.close()
}
