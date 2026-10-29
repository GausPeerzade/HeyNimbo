import type { VoiceEvent } from '../shared/ipc'

type Sentence = { line: number; text: string; language?: string }

export function bestSystemVoice(voices: SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | undefined {
  const lang = language.replaceAll('_', '-').toLowerCase(), base = lang.split('-')[0]
  const local = voices.filter(v => v.localService)
  const matching = local.filter(v => v.lang.replaceAll('_', '-').toLowerCase().split('-')[0] === base)
  const quality = (v: SpeechSynthesisVoice): number => {
    const identity = `${v.name} ${v.voiceURI}`
    return /premium/i.test(identity) ? 3 : /enhanced/i.test(identity) ? 2 : v.default ? 1 : 0
  }
  return (matching.length ? matching : local.filter(v => v.default)).sort((a, b) => quality(b) - quality(a) || Number(b.lang.toLowerCase() === lang) - Number(a.lang.toLowerCase() === lang))[0]
}

/** Owns utterances, but reports the same playback lifecycle as streamed PCM. */
export class SystemSpeech {
  private queue: Sentence[] = []
  private current: { sentence: Sentence; utterance: SpeechSynthesisUtterance; started: boolean } | undefined
  private ending = false
  private started = false
  private muted = false
  private generation = 0
  private active = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private waitingForVoices = false
  private readonly voicesChanged = (): void => { this.stopWaitingForVoices(); this.next() }

  constructor(
    private readonly synthesis: SpeechSynthesis,
    private readonly send: (event: VoiceEvent) => void,
    private readonly utterance = (text: string): SpeechSynthesisUtterance => new SpeechSynthesisUtterance(text),
    private readonly defaultLanguage = navigator.language,
  ) {}

  get hasAnswer(): boolean { return this.active }

  speak(sentence: Sentence): void {
    this.active = true
    this.queue.push(sentence)
    this.next()
  }

  end(): void { this.ending = true; this.drain() }

  mute(muted: boolean): void {
    this.muted = muted
    const current = this.current
    if (!muted) return
    if (!current) { this.next(); return }
    this.detach(current.utterance)
    this.synthesis.cancel()
    this.start(current)
    this.complete(current)
  }

  cancel(): void {
    this.generation++
    clearTimeout(this.timer)
    this.stopWaitingForVoices()
    if (this.current) this.detach(this.current.utterance)
    this.current = undefined
    this.queue = []
    this.ending = this.started = this.active = false
    this.synthesis.cancel()
  }

  private next(): void {
    if (this.current) return
    if (!this.queue.length) return this.drain()
    const voices = this.synthesis.getVoices()
    if (!this.muted && !voices.length) {
      if (!this.waitingForVoices) {
        this.waitingForVoices = true
        this.synthesis.addEventListener('voiceschanged', this.voicesChanged)
        this.timer = setTimeout(() => this.fail('No installed local system voice is available.'), 5_000)
      }
      return
    }
    this.stopWaitingForVoices()
    const sentence = this.queue.shift()!
    const utterance = this.utterance(sentence.text)
    const voice = bestSystemVoice(voices, sentence.language ?? this.defaultLanguage)
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang }
    const current = { sentence, utterance, started: false }, generation = this.generation
    this.current = current
    const live = (): boolean => generation === this.generation && this.current === current
    utterance.onstart = () => { if (live()) this.start(current) }
    utterance.onend = () => { if (live()) { this.start(current); this.complete(current) } }
    utterance.onerror = () => { if (live()) this.fail('Built-in speech playback failed.') }
    if (this.muted) {
      queueMicrotask(() => { if (live()) { this.start(current); this.complete(current) } })
    } else if (!voice) {
      // Never fall back to a network voice, including while voices are loading.
      this.fail('No installed local system voice is available. Check macOS Spoken Content voices.')
    } else {
      this.timer = setTimeout(() => { if (live()) this.fail('Built-in speech playback timed out.') }, 60_000)
      this.synthesis.speak(utterance)
    }
  }

  private start(current: NonNullable<SystemSpeech['current']>): void {
    if (current.started) return
    current.started = true
    if (!this.started) { this.started = true; this.send({ kind: 'playbackStarted' }) }
    this.send({ kind: 'lineScheduled', line: current.sentence.line, startsInMs: 0 })
  }

  private complete(current: NonNullable<SystemSpeech['current']>): void {
    clearTimeout(this.timer)
    this.detach(current.utterance)
    this.current = undefined
    this.next()
  }

  private stopWaitingForVoices(): void {
    if (!this.waitingForVoices) return
    clearTimeout(this.timer)
    this.waitingForVoices = false
    this.synthesis.removeEventListener('voiceschanged', this.voicesChanged)
  }

  private detach(utterance: SpeechSynthesisUtterance): void { utterance.onstart = utterance.onend = utterance.onerror = null }
  private fail(message: string): void { this.cancel(); this.send({ kind: 'playbackError', message }) }
  private drain(): void {
    if (!this.ending || this.current || this.queue.length) return
    this.ending = this.started = this.active = false
    this.send({ kind: 'playbackDrained' })
  }
}
