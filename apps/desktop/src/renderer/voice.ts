import type { NimboVoiceApi } from '../preload/voice'
import type { VoiceCommand } from '../shared/ipc'
import workletUrl from './pcm-capture-worklet.js?url'

declare global {
  interface Window {
    nimboVoice: NimboVoiceApi
  }
}

const RATE = 24_000
const send = window.nimboVoice.send

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
  await context.audioWorklet.addModule(workletUrl)
  const node = new AudioWorkletNode(context, 'pcm16-capture')
  node.port.onmessage = (event: MessageEvent<ArrayBuffer | 'flushed'>) => {
    if (event.data instanceof ArrayBuffer) send({ kind: 'micChunk', id, pcm: new Uint8Array(event.data) })
  }
  // The node must reach the destination to be pulled; it outputs silence.
  context.createMediaStreamSource(stream).connect(node).connect(context.destination)
  mic = { id, context, stream, node }
  send({ kind: 'micStarted', id })
}

async function stopMic(): Promise<void> {
  const current = mic
  mic = undefined
  if (!current) return
  await new Promise<void>((resolve) => {
    current.node.port.onmessage = (event: MessageEvent<ArrayBuffer | 'flushed'>) => {
      if (event.data instanceof ArrayBuffer) send({ kind: 'micChunk', id: current.id, pcm: new Uint8Array(event.data) })
      else resolve()
    }
    current.node.port.postMessage('flush')
  })
  current.stream.getTracks().forEach((track) => track.stop())
  await current.context.close()
  send({ kind: 'micStopped', id: current.id })
}

function queueMic(task: () => Promise<void>): void {
  micQueue = micQueue.then(task).catch((error: unknown) => {
    mic = undefined
    send({ kind: 'micError', message: error instanceof Error ? error.message : String(error) })
  })
}

const speaker = new AudioContext({ sampleRate: RATE })
const playing = new Set<AudioBufferSourceNode>()
let playhead = 0
let started = false
let ending = false

function resetPlayback(): void {
  playhead = 0
  started = false
  ending = false
}

function play(pcm: Uint8Array): void {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
  const buffer = speaker.createBuffer(1, samples.length, RATE)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] ?? 0) / 0x8000
  const source = speaker.createBufferSource()
  source.buffer = buffer
  source.connect(speaker.destination)
  // Schedule back to back; a small lead absorbs IPC jitter on the first chunk.
  const at = Math.max(playhead, speaker.currentTime + 0.02)
  source.start(at)
  playhead = at + buffer.duration
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

function handle(command: VoiceCommand): void {
  switch (command.kind) {
    case 'micStart':
      return queueMic(() => startMic(command.id))
    case 'micStop':
      return queueMic(stopMic)
    case 'play':
      void speaker.resume()
      return play(command.pcm)
    case 'playEnd':
      ending = true
      if (playing.size === 0) {
        resetPlayback()
        send({ kind: 'playbackDrained' })
      }
      return
    case 'playCancel':
      playing.forEach((source) => {
        source.onended = null
        source.stop()
      })
      playing.clear()
      resetPlayback()
  }
}

window.nimboVoice.onCommand(handle)
