import type { NimboVoiceApi } from '../preload/voice'
import type { VoiceCommand } from '../shared/ipc'
import { SystemSpeech } from './system-speech'
import workletUrl from './pcm-capture-worklet.js?url'

declare global {
  interface Window {
    nimboVoice: NimboVoiceApi
  }
}

const RATE = 24_000
const send = window.nimboVoice.send
const systemSpeech = new SystemSpeech(window.speechSynthesis, send)
// Prime Chromium's asynchronous installed-voice discovery before the first answer.
window.speechSynthesis.getVoices()

interface Mic {
  id: number
  context: AudioContext
  stream: MediaStream
  node: AudioWorkletNode
}

let mic: Mic | undefined
// Mic commands run strictly in order, so a quick tap that stops before the
// microphone finished opening cannot leave it running.
let micQueue: Promise<void> = Promise.resolve()

async function startMic(id: number): Promise<void> {
  if (mic) await stopMic()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const context = new AudioContext({ sampleRate: RATE })
  try {
    await context.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(context, 'pcm16-capture')
    node.port.onmessage = (event: MessageEvent<ArrayBuffer | 'flushed'>) => {
      if (event.data instanceof ArrayBuffer) send({ kind: 'micChunk', id, pcm: new Uint8Array(event.data) })
    }
    // The node must reach the destination to be pulled; it outputs silence.
    context.createMediaStreamSource(stream).connect(node).connect(context.destination)
    mic = { id, context, stream, node }
    send({ kind: 'micStarted', id })
  } catch (error) {
    // Never leave the microphone open after a failed start.
    stream.getTracks().forEach((track) => track.stop())
    await context.close()
    throw error
  }
}

/** How long to wait for the worklet's last chunk before closing anyway. */
const FLUSH_TIMEOUT_MS = 300

async function stopMic(): Promise<void> {
  const current = mic
  mic = undefined
  if (!current) return
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)
      current.node.port.onmessage = (event: MessageEvent<ArrayBuffer | 'flushed'>) => {
        if (event.data instanceof ArrayBuffer) send({ kind: 'micChunk', id: current.id, pcm: new Uint8Array(event.data) })
        else {
          clearTimeout(timer)
          resolve()
        }
      }
      current.node.port.postMessage('flush')
    })
  } finally {
    current.stream.getTracks().forEach((track) => track.stop())
    await current.context.close()
    send({ kind: 'micStopped', id: current.id })
  }
}

function queueMic(task: () => Promise<void>): void {
  micQueue = micQueue.then(task).catch((error: unknown) => {
    mic = undefined
    send({ kind: 'micError', message: error instanceof Error ? error.message : String(error) })
  })
}

const speaker = new AudioContext({ sampleRate: RATE })
const output = speaker.createGain()
output.connect(speaker.destination)
const playing = new Set<AudioBufferSourceNode>()
const scribbling = new Set<AudioBufferSourceNode>()
let playhead = 0
let started = false
let ending = false
let lastLine = -1

function resetPlayback(): void {
  playhead = 0
  started = false
  ending = false
  lastLine = -1
}

function play(line: number, pcm: Uint8Array): void {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
  const buffer = speaker.createBuffer(1, samples.length, RATE)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] ?? 0) / 0x8000
  const source = speaker.createBufferSource()
  source.buffer = buffer
  source.connect(output)
  // Schedule back to back; a small lead absorbs IPC jitter on the first chunk.
  const at = Math.max(playhead, speaker.currentTime + 0.02)
  source.start(at)
  playhead = at + buffer.duration
  if (line !== lastLine) {
    lastLine = line
    send({ kind: 'lineScheduled', line, startsInMs: Math.max(0, (at - speaker.currentTime) * 1000) })
  }
  playing.add(source)
  source.onended = () => {
    playing.delete(source)
    if (ending && playing.size === 0) {
      resetPlayback()
      send({ kind: 'playbackDrained' })
    }
  }
  if (!started) {
    started = true
    send({ kind: 'playbackStarted' })
  }
}

/** A quiet pencil-on-paper sound: band-passed noise with uneven pressure. */
function scribble(durationMs: number): void {
  const seconds = Math.max(0, durationMs / 1000)
  if (!seconds) return
  const noise = speaker.createBuffer(1, Math.ceil(RATE * seconds), RATE)
  const samples = noise.getChannelData(0)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
  const source = speaker.createBufferSource()
  source.buffer = noise
  const band = speaker.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 3200
  band.Q.value = 0.9
  const pressure = speaker.createGain()
  const start = speaker.currentTime
  pressure.gain.setValueAtTime(0, start)
  for (let t = 0; t < seconds; t += 0.08 + Math.random() * 0.09) {
    pressure.gain.linearRampToValueAtTime(0.01 + Math.random() * 0.025, start + t)
  }
  pressure.gain.linearRampToValueAtTime(0, start + seconds)
  source.connect(band).connect(pressure).connect(output)
  scribbling.add(source)
  source.onended = () => scribbling.delete(source)
  source.start(start)
  source.stop(start + seconds)
}

function handle(command: VoiceCommand): void {
  switch (command.kind) {
    case 'mute':
      output.gain.value = command.muted ? 0 : 1
      systemSpeech.mute(command.muted)
      return
    case 'micStart':
      return queueMic(() => startMic(command.id))
    case 'micStop':
      return queueMic(stopMic)
    case 'play':
      void speaker.resume()
      return play(command.line, command.pcm)
    case 'systemSpeak':
      return systemSpeech.speak(command)
    case 'scribble':
      void speaker.resume()
      return scribble(command.durationMs)
    case 'playEnd':
      if (systemSpeech.hasAnswer) return systemSpeech.end()
      ending = true
      if (playing.size === 0) {
        resetPlayback()
        send({ kind: 'playbackDrained' })
      }
      return
    case 'playCancel':
      systemSpeech.cancel()
      scribbling.forEach((source) => source.stop())
      scribbling.clear()
      playing.forEach((source) => {
        source.onended = null
        source.stop()
      })
      playing.clear()
      resetPlayback()
  }
}

window.nimboVoice.onCommand(handle)
