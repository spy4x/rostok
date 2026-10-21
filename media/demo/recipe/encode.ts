/**
 * Turns the takes record.sh recorded into the finished demo video, without recording again.
 *
 * ```bash
 * deno run -A media/demo/recipe/encode.ts <work dir> [music file]
 * ```
 *
 * Reads the terminal shots (`<work dir>/NN-*.mp4`, from vhs), the browser frames
 * (`<work dir>/browser/`, from browser.ts), `deploy-seconds` and `url`. Writes `media/demo/`:
 * `demo.webm`, `demo.mp4`, `poster.webp`, `poster-640.webp` and `captions.vtt`.
 *
 * The video is a title card, one shot per caption in {@link SHOTS}, and an end card. Each shot is
 * held on its last frame until its caption has had time to be read. The captions are written to
 * `captions.vtt` and burned in from the same list, on a band at the bottom that no shot draws
 * under: the terminal is 716 px tall and the browser 56 + 660 px. The music (the second argument,
 * `media/demo/music.opus` by default) is trimmed to the video, faded in over 1 s and out over 2 s,
 * and set to {@link LOUDNESS}; the encoder refuses a track shorter than the video, and a mix that
 * measures louder.
 *
 * @module
 */
import { dirname, fromFileUrl, join } from "@std/path"

const HERE = dirname(fromFileUrl(import.meta.url))
const OUT = join(HERE, "..")
const FONT = join(HERE, "fonts/ibm-plex-sans-latin-400-normal.woff2")
const FONT_BOLD = join(HERE, "fonts/ibm-plex-sans-latin-600-normal.woff2")
const W = 1280
const H = 800
const FPS = 30
/** The caption band's height at the bottom of the frame. */
const BAND = 84
/** The address bar drawn above the browser's 660 px viewport. */
const BAR = 56
/** The site's dark palette, as the terminal theme uses it. */
const INK = "0x15120f"
const DESK = "0x1c1916"
const PAPER = "0x25211d"
const PARCHMENT = "0xefebe2"
const GRAPHITE = "0xbcb7af"
/** The mix's target integrated loudness (LUFS) and the highest true peak it may reach (dBTP). */
const LOUDNESS = { integrated: -28, peak: -1 }

/** One shot of the video: a terminal take or a slice of the browser recording, and its caption. */
interface Shot {
  /** A terminal take `<work dir>/<take>.mp4`, or a browser shot named in `browser/shots.json`. */
  take?: string
  browser?: string
  caption: string
  /** Fade through black at the start, to mark a cut that skips time. */
  fadeIn?: boolean
  fadeOut?: boolean
}

/** Rounds the deploy's real length into words: "2 min 10 s" or "50 s". */
export function durationWords(seconds: number): string {
  const s = Math.round(seconds / 10) * 10
  return s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`
}

/** The shot list. The deploy's caption names the time the cut skips. */
export function shots(deploySeconds: number): Shot[] {
  return [
    { take: "01-install", caption: "Install rostok with one Deno command" },
    { take: "02-wizard", caption: "Run rostok in an empty folder: a short wizard starts" },
    {
      take: "03-server",
      caption: "Tell it about your server: SSH address, domain and email",
    },
    { take: "04-defaults", caption: "Press Enter to keep the defaults for the rest" },
    {
      take: "05-pick",
      caption: "Pick services from the catalog: Traefik for HTTPS, and OmniTools",
    },
    {
      take: "06-written",
      caption: "The project is written: one folder per server, with its settings",
    },
    {
      take: "07-deploy",
      caption: "Deploy: rostok copies the files to the server and starts them",
      fadeOut: true,
    },
    {
      take: "08-deployed",
      caption: `${durationWords(deploySeconds)} later (cut short here), the deploy is done`,
      fadeIn: true,
    },
    { browser: "live", caption: "OmniTools is live on its own address, with HTTPS" },
    { browser: "search", caption: "Search its tools and open the QR code generator" },
    { browser: "qr", caption: "Type a link, and the QR code follows as you type" },
  ]
}

/** The longest caption that fits the band on one line and stays readable on a small player. */
export const MAX_CAPTION = 64

/**
 * How long a caption must stay to be read: 15 characters a second, and never under 2.5 s.
 *
 * @throws When the caption is longer than {@link MAX_CAPTION} characters.
 */
export function readingSeconds(caption: string): number {
  if (caption.length > MAX_CAPTION) {
    throw new Error(`caption over ${MAX_CAPTION} characters: "${caption}"`)
  }
  return Math.max(2.5, caption.length / 15 + 0.6)
}

/** Formats seconds as a WebVTT timestamp, `00:01:02.345`. */
export function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = (ms / 1000) % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${
    s.toFixed(3).padStart(6, "0")
  }`
}

/** Writes the WebVTT file for captions placed at the given times. */
export function vtt(cues: { start: number; end: number; text: string }[]): string {
  return `WEBVTT\n\n${
    cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`)
      .join("\n")
  }`
}

async function run(cmd: string, args: string[]): Promise<string> {
  const r = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output()
  const d = new TextDecoder()
  if (!r.success) {
    throw new Error(`${cmd} failed:\n${d.decode(r.stderr).split("\n").slice(-15).join("\n")}`)
  }
  return d.decode(r.stdout) + d.decode(r.stderr)
}

/** Runs ffmpeg on two threads for the output, so encoding leaves the machine usable. */
const ffmpeg = (args: string[]) =>
  run("ffmpeg", ["-v", "error", "-y", ...args.slice(0, -1), "-threads", "2", ...args.slice(-1)])

/**
 * Throws when the music track ends before the video does: the mix would stop dead and leave the
 * last seconds silent, instead of fading out over the end card.
 */
export function assertMusicCovers(musicSeconds: number, videoSeconds: number): void {
  if (musicSeconds < videoSeconds) {
    throw new Error(
      `the music is ${musicSeconds.toFixed(1)} s but the video ${videoSeconds.toFixed(1)} s: ` +
        `shorten the video or pick a longer track`,
    )
  }
}

async function duration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
  ])
  return Number(out.trim())
}

/** Escapes a value for an ffmpeg filter option. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")

/** A drawtext filter reading its text from a file, so no caption needs filter escaping. */
function text(file: string, font: string, size: number, color: string, x: string, y: string) {
  return `drawtext=fontfile='${esc(font)}':textfile='${
    esc(file)
  }':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`
}

/** Encodes one normalized segment: 1280x800, 30 fps, lossless, no audio. */
async function segment(out: string, inputArgs: string[], filter: string): Promise<number> {
  await ffmpeg([...inputArgs, "-vf", `${filter},fps=${FPS},format=yuv420p`, "-an", ...[
    "-c:v",
    "ffv1",
  ], out])
  return await duration(out)
}

/** A card: a title and a line under it, centred on Ink. */
async function card(work: string, name: string, title: string, sub: string, seconds: number) {
  await Deno.writeTextFile(join(work, `${name}-title.txt`), title)
  await Deno.writeTextFile(join(work, `${name}-sub.txt`), sub)
  const out = join(work, `seg-${name}.mkv`)
  await segment(
    out,
    ["-f", "lavfi", "-i", `color=c=${INK}:s=${W}x${H}:d=${seconds}:r=${FPS}`],
    [
      text(join(work, `${name}-title.txt`), FONT_BOLD, 64, PARCHMENT, "(w-tw)/2", "h/2-th-14"),
      text(join(work, `${name}-sub.txt`), FONT, 30, GRAPHITE, "(w-tw)/2", "h/2+22"),
      "fade=t=in:st=0:d=0.4",
      `fade=t=out:st=${seconds - 0.4}:d=0.4`,
    ].join(","),
  )
  return out
}

async function main(work: string, music: string) {
  const deploySeconds = Number(await Deno.readTextFile(join(work, "deploy-seconds")))
  const host = (await Deno.readTextFile(join(work, "url"))).trim().replace(/^https:\/\/|\/$/g, "")
  await Deno.writeTextFile(join(work, "host.txt"), host)
  const list = shots(deploySeconds)

  // The browser frames, each held until the next one arrives, as one 30 fps take.
  const bdir = join(work, "browser")
  const frames: number[] = JSON.parse(await Deno.readTextFile(join(bdir, "frames.json")))
  const bshots: { name: string; start: number; end: number }[] = JSON.parse(
    await Deno.readTextFile(join(bdir, "shots.json")),
  )
  const end = bshots.at(-1)!.end
  const name = (i: number) => `${String(i).padStart(5, "0")}.jpg`
  const concat = ["ffconcat version 1.0"]
  frames.forEach((t, i) => {
    const next = i + 1 < frames.length ? frames[i + 1] : Math.max(end, t + 0.04)
    concat.push(`file ${name(i)}`, `duration ${(next - t).toFixed(4)}`)
  })
  concat.push(`file ${name(frames.length - 1)}`)
  await Deno.writeTextFile(join(bdir, "frames.ffconcat"), concat.join("\n"))
  await ffmpeg([
    ...["-f", "concat", "-safe", "0", "-i", join(bdir, "frames.ffconcat")],
    // The frames are the 1024x528 viewport; scaled by 1.25 they fill the 1280x660 under the bar.
    ...["-vf", `fps=${FPS},scale=${W}:${H - BAR - BAND}:flags=lanczos,format=yuv420p`],
    ...["-c:v", "ffv1", join(work, "browser.mkv")],
  ])
  // The headless browser has no window, so draw a plain address bar with the real host and a
  // lock: record.sh checked that the page answers over a valid certificate before recording.
  const bar = [
    `pad=${W}:${H}:0:${BAR}:color=${DESK}`,
    `drawbox=x=24:y=10:w=${W - 48}:h=36:color=${PAPER}:t=fill`,
    `drawbox=x=42:y=19:w=10:h=10:color=${GRAPHITE}:t=2`,
    `drawbox=x=39:y=26:w=16:h=12:color=${GRAPHITE}:t=fill`,
    text(join(work, "host.txt"), FONT, 20, PARCHMENT, "68", "28-th/2"),
    // The band area under the viewport is Ink, like the terminal's.
    `drawbox=x=0:y=${H - BAND}:w=${W}:h=${BAND}:color=${INK}:t=fill`,
  ].join(",")

  const segs: string[] = [
    await card(
      work,
      "title",
      "rostok",
      "Scaffold a self-hosted homelab from a curated catalog.",
      2,
    ),
  ]
  const cues: { start: number; end: number; text: string }[] = []
  let t = await duration(segs[0])
  let posterSeg = ""
  for (const [i, shot] of list.entries()) {
    const out = join(work, `seg-${String(i).padStart(2, "0")}.mkv`)
    const b = shot.browser ? bshots.find((x) => x.name === shot.browser) : undefined
    if (shot.browser && !b) throw new Error(`browser shot ${shot.browser} is not in shots.json`)
    const input = b
      ? ["-ss", b.start.toFixed(3), "-to", b.end.toFixed(3), "-i", join(work, "browser.mkv")]
      : ["-i", join(work, `${shot.take}.mp4`)]
    const raw = b ? b.end - b.start : await duration(join(work, `${shot.take}.mp4`))
    const hold = Math.max(0, readingSeconds(shot.caption) - raw)
    const filters = [
      "setpts=PTS-STARTPTS",
      shot.take ? `pad=${W}:${H}:0:0:color=${INK}` : bar,
      `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`,
    ]
    const len = raw + hold
    if (shot.fadeIn) filters.push("fade=t=in:st=0:d=0.35")
    if (shot.fadeOut) filters.push(`fade=t=out:st=${(len - 0.35).toFixed(3)}:d=0.35`)
    const d = await segment(out, input, filters.join(","))
    segs.push(out)
    cues.push({ start: t, end: t + d, text: shot.caption })
    if (shot.take === "05-pick") posterSeg = out
    t += d
  }
  const contentEnd = t
  segs.push(
    await card(work, "end", "github.com/spy4x/rostok", "Free and open source, MIT licence", 2.5),
  )

  await Deno.writeTextFile(
    join(work, "segments.ffconcat"),
    ["ffconcat version 1.0", ...segs.map((s) => `file ${s}`)].join("\n"),
  )
  await ffmpeg([
    ...["-f", "concat", "-safe", "0", "-i", join(work, "segments.ffconcat")],
    ...["-c:v", "ffv1", join(work, "joined.mkv")],
  ])
  const total = await duration(join(work, "joined.mkv"))

  // The poster: the stack picker with both services ticked, before any caption is drawn.
  if (!posterSeg) throw new Error("the poster's shot (05-pick) is missing")
  await ffmpeg(["-sseof", "-0.1", "-i", posterSeg, "-frames:v", "1", join(work, "poster.png")])
  await ffmpeg([
    ...["-i", join(work, "poster.png"), "-c:v", "libwebp", "-quality", "82"],
    ...["-map_metadata", "-1", join(OUT, "poster.webp")],
  ])
  await ffmpeg([
    ...["-i", join(work, "poster.png"), "-vf", "scale=640:-2", "-c:v", "libwebp"],
    ...["-quality", "82", "-map_metadata", "-1", join(OUT, "poster-640.webp")],
  ])

  // Captions: the band under every shot, and each line fading in and out with its shot.
  const captionFilters = [
    `drawbox=x=0:y=${H - BAND}:w=${W}:h=${BAND}:color=${PAPER}@0.92:t=fill:enable='between(t,${
      cues[0].start.toFixed(3)
    },${contentEnd.toFixed(3)})'`,
  ]
  for (const [i, c] of cues.entries()) {
    const file = join(work, `caption-${i}.txt`)
    await Deno.writeTextFile(file, c.text)
    const a = c.start.toFixed(3)
    const b = c.end.toFixed(3)
    captionFilters.push(
      `${
        text(file, FONT, 30, PARCHMENT, "(w-tw)/2", `${H - BAND / 2}-th/2-4`)
      }:enable='between(t,${a},${b})':alpha='min(1,min((t-${a})/0.2,(${b}-t)/0.2))'`,
    )
  }
  await Deno.writeTextFile(join(OUT, "captions.vtt"), vtt(cues))
  await Deno.writeTextFile(join(work, "captions.filter"), captionFilters.join(",\n"))

  // The music: trimmed, faded, then set to the target loudness from a first measurement.
  assertMusicCovers(await duration(music), total)
  const shaped = `atrim=0:${total.toFixed(3)},afade=t=in:st=0:d=1,afade=t=out:st=${
    (total - 2).toFixed(3)
  }:d=2`
  const measured = await loudness(["-i", music, "-af", shaped])
  const gain = LOUDNESS.integrated - measured.integrated
  await ffmpeg([
    ...["-i", music, "-af", `${shaped},volume=${gain.toFixed(2)}dB,apad=whole_dur=${total}`],
    ...["-c:a", "pcm_s16le", "-ar", "48000", join(work, "music.wav")],
  ])
  const mix = await loudness(["-i", join(work, "music.wav"), "-af", "anull"])
  if (Math.abs(mix.integrated - LOUDNESS.integrated) > 1 || mix.peak > LOUDNESS.peak) {
    throw new Error(
      `the mix measures ${mix.integrated} LUFS, ${mix.peak} dBTP; wanted about ` +
        `${LOUDNESS.integrated} LUFS and at most ${LOUDNESS.peak} dBTP`,
    )
  }

  const common = [
    ...["-i", join(work, "joined.mkv"), "-i", join(work, "music.wav")],
    ...["-filter_script:v", join(work, "captions.filter"), "-map", "0:v", "-map", "1:a"],
    ...["-shortest", "-map_metadata", "-1", "-r", String(FPS), "-pix_fmt", "yuv420p"],
  ]
  await ffmpeg([
    ...common,
    ...["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "42", "-row-mt", "1", "-deadline", "good"],
    ...["-cpu-used", "2", "-c:a", "libopus", "-b:a", "96k", join(OUT, "demo.webm")],
  ])
  await ffmpeg([
    ...common,
    ...["-c:v", "libx264", "-preset", "slow", "-crf", "27", "-c:a", "aac", "-b:a", "128k"],
    ...["-movflags", "+faststart", join(OUT, "demo.mp4")],
  ])
  const final = await loudness(["-i", join(OUT, "demo.mp4"), "-af", "anull"])
  console.log(`length ${total.toFixed(1)} s, ${final.integrated} LUFS, ${final.peak} dBTP`)
  for (const f of ["demo.webm", "demo.mp4", "poster.webp", "poster-640.webp"]) {
    console.log(`${f}: ${((await Deno.stat(join(OUT, f))).size / 1e6).toFixed(2)} MB`)
  }
}

/** Measures integrated loudness and true peak with ffmpeg's EBU R128 filter. */
async function loudness(input: string[]): Promise<{ integrated: number; peak: number }> {
  const af = input.indexOf("-af")
  const args = [...input]
  args[af + 1] = `${args[af + 1]},ebur128=peak=true`
  const r = await new Deno.Command("ffmpeg", {
    args: ["-hide_banner", "-nostats", ...args, "-f", "null", "-"],
    stdout: "null",
    stderr: "piped",
  }).output()
  const log = new TextDecoder().decode(r.stderr)
  const summary = log.slice(log.lastIndexOf("Summary:"))
  const integrated = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1])
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1])
  if (!r.success || Number.isNaN(integrated) || Number.isNaN(peak)) {
    throw new Error(`could not measure loudness:\n${log.slice(-800)}`)
  }
  return { integrated, peak }
}

if (import.meta.main) {
  const [work, music = join(OUT, "music.opus")] = Deno.args
  if (!work) throw new Error("usage: encode.ts <work dir> [music file]")
  try {
    await Deno.stat(music)
  } catch {
    throw new Error(`no music at ${music}: copy the assigned track there first (see MUSIC.md)`)
  }
  await main(work, music)
}
