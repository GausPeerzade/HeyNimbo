#!/usr/bin/env node
// Record only your consented desktop. Launch the dev drawing demo with
// HEYNIMBO_DEBUG_NO_CONTENT_PROTECTION=1; this separate process includes its ink.
// Usage: node scripts/record-overlay.cjs /tmp/heynimbo-draw 18
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')
const { captureScreens, hasScreenCaptureAccess } = require('../crates/heynimbo-native')

async function record() {
  if (!hasScreenCaptureAccess()) throw new Error('Screen Recording access is required; no permission prompt is issued.')
  const output = process.argv[2] || '/tmp/heynimbo-draw'
  const seconds = Number(process.argv[3] || 18)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Duration must be a positive number of seconds.')
  await mkdir(output, { recursive: true })
  const start = performance.now()
  const frames = []
  let displayId
  // No sleep or overlapping captures: run the native capture path at its
  // maximum sustainable rate, and retain real timestamps rather than fake fps.
  while (performance.now() - start < seconds * 1000) {
    const at = performance.now() - start
    const capture = await captureScreens({ allDisplays: true, maxLongEdge: 1440, jpegQuality: 85 })
    displayId ??= capture.displays[0]?.displayId
    const display = capture.displays.find((item) => item.displayId === displayId)
    if (!display) throw new Error('The recorded display disconnected.')
    const file = `f${String(frames.length).padStart(4, '0')}_${String(Math.round(at)).padStart(6, '0')}ms.jpg`
    await writeFile(join(output, file), display.jpeg)
    frames.push({ file, atMs: at, capturedMs: performance.now() - start, captureMs: capture.captureMs, encodeMs: capture.encodeMs })
  }
  const elapsed = performance.now() - start
  const summary = { displayId, frames: frames.length, elapsedMs: elapsed, fps: frames.length / (elapsed / 1000), samples: frames }
  await writeFile(join(output, 'recording.json'), JSON.stringify(summary, null, 2))
  console.info(`Recorded ${frames.length} frames in ${(elapsed / 1000).toFixed(2)}s (${summary.fps.toFixed(1)} fps): ${output}`)
}

record().catch((error) => { console.error(error.message); process.exitCode = 1 })
