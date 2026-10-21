import { assertEquals, assertThrows } from "@std/assert"
import {
  assertMusicCovers,
  durationWords,
  MAX_CAPTION,
  readingSeconds,
  shots,
  vtt,
  vttTime,
} from "./encode.ts"

Deno.test("deploy caption names the cut time in minutes and seconds, rounded to 10 s", () => {
  assertEquals(durationWords(134), "2 min 10 s")
  assertEquals(durationWords(118), "2 min")
  assertEquals(durationWords(52), "50 s")
  assertEquals(
    shots(134).find((s) => s.take === "08-deployed")?.caption.startsWith("2 min 10 s"),
    true,
  )
})

Deno.test("a caption stays at least 2.5 s and long enough to read at 15 characters a second", () => {
  assertEquals(readingSeconds("Short"), 2.5)
  assertEquals(readingSeconds("x".repeat(60)), 4.6)
})

Deno.test("captions.vtt lists each cue with WebVTT timestamps", () => {
  assertEquals(vttTime(62.3456), "00:01:02.346")
  assertEquals(
    vtt([{ start: 2, end: 5.5, text: "Install rostok" }]),
    "WEBVTT\n\n1\n00:00:02.000 --> 00:00:05.500\nInstall rostok\n",
  )
})

Deno.test("every caption fits in 64 characters, and a longer one is refused", () => {
  for (const shot of shots(600)) {
    assertEquals(shot.caption.length <= MAX_CAPTION, true, shot.caption)
  }
  assertThrows(() => readingSeconds("x".repeat(65)), Error, "over 64 characters")
})

Deno.test("the encoder refuses a music track shorter than the video", () => {
  assertMusicCovers(90, 87.5)
  assertMusicCovers(90, 90)
  assertThrows(
    () => assertMusicCovers(90, 103.8),
    Error,
    "the music is 90.0 s but the video 103.8 s",
  )
})
