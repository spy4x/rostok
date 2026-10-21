# How the demo video is made

The video in `media/demo/` shows a new user's first run: install rostok, answer the wizard,
deploy OmniTools and Traefik to a fresh server, then use OmniTools in the browser. Everything is
recorded for real, on a throwaway Hetzner Cloud server that the recipe rents and deletes. One run
takes about 15 minutes and costs about one cent.

## What you need

- Deno, podman, tmux, [vhs](https://github.com/charmbracelet/vhs) (with the Noto Sans Mono font),
  ffmpeg (with libvpx-vp9, libx264, libopus, libwebp and freetype), curl and ssh-keygen.
- Playwright's Chromium: `deno run -A npm:playwright@1.63.0 install chromium`.
- A Hetzner Cloud API token with read and write access, in `HETZNER_CLOUD_API_TOKEN`.
- The music track at `media/demo/music.opus` (see `media/demo/MUSIC.md`).

## Remake the video

1. Load the token for this one command only, from wherever you keep it, and run the task:

   ```bash
   T="$(sed -n 's/^HETZNER_CLOUD_API_TOKEN=//p' <your env file>)" \
     && HETZNER_CLOUD_API_TOKEN="$T" deno task demo-video
   ```

   `record.sh` builds a clean container (`Containerfile`, `bashrc`), rents the cheapest x86
   server (`vm.ts`), records the terminal shot by shot with vhs (`tapes/`), waits for the deploy,
   records the browser (`browser.ts`), deletes the server and its SSH key, then runs
   `encode.ts`. The token reaches `vm.ts` only; nothing else the recipe starts inherits it. The
   server is deleted on every exit, failed runs included.
2. Look at every frame before you commit:

   ```bash
   ffmpeg -i media/demo/demo.mp4 -vf "fps=1,scale=320:-1,tile=6x12" -frames:v 1 sheet.png
   ```

   Each caption must be readable, nothing it talks about hidden, and the cards present.
3. Commit `media/demo/` (the videos, posters and `captions.vtt`). The takes are not committed.

To change a caption or the music without recording again, edit `encode.ts` (the shot list) or
replace `music.opus`, then re-encode the takes the last run printed:

```bash
deno task demo-video:encode <work dir>
```

## How it is built

- **Terminal.** One vhs tape per shot (`tapes/NN-*.tape`, after `tapes/settings.tape`), each
  attaching to the same tmux session, so every caption covers exactly one shot. The shell prints
  a blank line and a full-width rule before every prompt, so each command starts under a visible
  separator. The deploy is cut: the shot after the cut fades in and its caption says how long the
  deploy really took.
- **Browser.** `browser.ts` records with the DevTools screencast, which stamps every frame, so a
  busy machine records fewer frames but never wrong timing. The pointer and click marks come
  from `pointer.js` and `human-mouse.ts` (the `demo-video` skill's helpers). The page lays out
  in a 1024x528 viewport and `encode.ts` scales its frames by 1.25 to fill 1280x660, so its text
  stays readable on a small player. The screencast only sends CSS-pixel frames, and CSS `zoom`
  breaks OmniTools' search results, so the scaling happens in the encoder.
  Both files are left out of `deno check` (see `deno.jsonc`) and run with `--no-lock`, so
  Playwright never enters `deno.lock`.
- **Encoding.** `encode.ts` holds each shot until its caption has been on screen long enough to
  read, adds the title and end cards, writes `captions.vtt`, burns the captions in with the IBM
  Plex Sans files in `fonts/` (OFL), mixes the music to -28 LUFS and encodes WebM and MP4.
- **Picking stacks.** `tapes/05-pick.tape` moves up through the catalog list by count, and
  `record.sh` then checks that exactly `traefik` and `omni-tools` are ticked. Adding or removing
  a stack can change the counts: the run then stops at that check, and the counts in the tape
  need updating.
