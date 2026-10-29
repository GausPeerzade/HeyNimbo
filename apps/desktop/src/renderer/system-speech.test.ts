import { afterEach, expect, it, vi } from 'vitest'
import { bestSystemVoice, SystemSpeech } from './system-speech'
import { BuiltInMouth } from '../main/voice/builtin-mouth'
import type { VoiceCommand, VoiceEvent } from '../shared/ipc'
vi.mock('@nimboguide/native', () => ({ speechLanguage: () => 'fr' }))
const voice = (name: string, lang = 'fr-FR', isDefault = false, localService = true): SpeechSynthesisVoice => ({ name, lang, default: isDefault, localService, voiceURI: name })
afterEach(() => { vi.useRealTimers() })
function fixture() {
  const played: SpeechSynthesisUtterance[] = [], events: VoiceEvent[] = []
  const synthesis = { getVoices: () => [voice('French Enhanced')], speak: vi.fn((u: SpeechSynthesisUtterance) => played.push(u)), cancel: vi.fn(), addEventListener: vi.fn((_event: string, _listener: () => void) => {}), removeEventListener: vi.fn() }
  const speech = new SystemSpeech(synthesis as unknown as SpeechSynthesis, e => events.push(e), text => ({ text }) as SpeechSynthesisUtterance, 'en-US')
  const send = (c: VoiceCommand): void => {
    if (c.kind === 'systemSpeak') speech.speak(c)
    if (c.kind === 'playEnd') speech.end()
    if (c.kind === 'playCancel') speech.cancel()
    if (c.kind === 'mute') speech.mute(c.muted)
  }
  return { speech, synthesis, played, events, mouth: new BuiltInMouth({ send }), send }
}
function start(u: SpeechSynthesisUtterance): void { u.onstart?.({} as SpeechSynthesisEvent) }
function end(u: SpeechSynthesisUtterance): void { u.onend?.({} as SpeechSynthesisEvent) }
it('prefers local Premium, Enhanced, then default voices for the answer language', () => {
  const frenchDefault = voice('Default', 'fr-FR', true), enhanced = voice('French Enhanced'), premium = voice('French Premium')
  const remote = voice('Remote Premium', 'fr-FR', false, false)
  expect(bestSystemVoice([frenchDefault, enhanced, voice('English Premium', 'en-US')], 'fr')).toBe(enhanced)
  expect(bestSystemVoice([enhanced, premium, remote], 'fr-CA')).toBe(premium)
  expect(bestSystemVoice([voice('Basic'), frenchDefault], 'fr')).toBe(frenchDefault)
  expect(bestSystemVoice([remote], 'fr')).toBeUndefined()
  const uriPremium = { ...voice('Amélie'), voiceURI: 'com.apple.voice.premium.fr-FR.Amelie' }
  expect(bestSystemVoice([enhanced, uriPremium], 'fr')).toBe(uriPremium)
})
it('maps utterance starts and ends to drawing lines and drains only after playEnd and the last end', async () => {
  const { mouth, send, played, events } = fixture()
  await mouth.speak('Bonjour.', vi.fn(), 1); await mouth.speak('Au revoir.', vi.fn(), 2)
  expect(played).toHaveLength(1); expect(played[0]?.lang).toBe('fr-FR'); expect(events).toEqual([])
  start(played[0]!); start(played[0]!)
  expect(events).toEqual([{ kind: 'playbackStarted' }, { kind: 'lineScheduled', line: 1, startsInMs: 0 }])
  end(played[0]!); expect(played).toHaveLength(2)
  send({ kind: 'playEnd' }); expect(events.at(-1)?.kind).not.toBe('playbackDrained')
  start(played[1]!); end(played[1]!)
  expect(events).toEqual([{ kind: 'playbackStarted' }, { kind: 'lineScheduled', line: 1, startsInMs: 0 }, { kind: 'lineScheduled', line: 2, startsInMs: 0 }, { kind: 'playbackDrained' }])
})
it('waits for playEnd if the last utterance ends before answer streaming finishes', async () => {
  const { mouth, played, events, send } = fixture()
  await mouth.speak('Bonjour.', vi.fn(), 1); start(played[0]!); end(played[0]!)
  expect(events.at(-1)?.kind).toBe('lineScheduled')
  send({ kind: 'playEnd' }); expect(events.at(-1)?.kind).toBe('playbackDrained')
})
it('cancel stops speech, empties queued sentences, and ignores saved late callbacks', async () => {
  const { mouth, synthesis, played, events } = fixture()
  await mouth.speak('Bonjour.', vi.fn(), 1); await mouth.speak('Suite.', vi.fn(), 2)
  const lateStart = played[0]!.onstart!.bind(played[0]!), lateEnd = played[0]!.onend!.bind(played[0]!)
  mouth.cancel(); lateStart({} as SpeechSynthesisEvent); lateEnd({} as SpeechSynthesisEvent)
  expect(synthesis.cancel).toHaveBeenCalledOnce(); expect(events).toEqual([]); expect(played).toHaveLength(1)
})
it('mute suppresses synthesis but preserves drawing and completion events', async () => {
  const { mouth, send, events, synthesis } = fixture()
  send({ kind: 'mute', muted: true })
  await mouth.speak('Bonjour.', vi.fn(), 3); send({ kind: 'playEnd' }); await Promise.resolve()
  expect(synthesis.speak).not.toHaveBeenCalled()
  expect(events).toEqual([{ kind: 'playbackStarted' }, { kind: 'lineScheduled', line: 3, startsInMs: 0 }, { kind: 'playbackDrained' }])
})
it('muting active speech cancels it immediately without late events or a stuck turn', async () => {
  const { mouth, send, events, played, synthesis } = fixture()
  await mouth.speak('Bonjour.', vi.fn(), 1); const lateEnd = played[0]!.onend!.bind(played[0]!)
  start(played[0]!); send({ kind: 'playEnd' }); send({ kind: 'mute', muted: true })
  expect(synthesis.cancel).toHaveBeenCalledOnce(); expect(events.at(-1)?.kind).toBe('playbackDrained')
  const count = events.length; lateEnd({} as SpeechSynthesisEvent); expect(events).toHaveLength(count)
})
it('fails safely instead of silently using a network voice', () => {
  const { speech, synthesis, events } = fixture()
  synthesis.getVoices = () => [voice('Remote', 'fr-FR', true, false)]
  speech.speak({ line: 1, text: 'Bonjour', language: 'fr' })
  expect(synthesis.speak).not.toHaveBeenCalled(); expect(events[0]?.kind).toBe('playbackError')
})
it('fails a hung utterance and ignores callbacks after the timeout', () => {
  vi.useFakeTimers()
  const { speech, played, events, synthesis } = fixture()
  speech.speak({ line: 1, text: 'Bonjour', language: 'fr' }); const lateEnd = played[0]!.onend!.bind(played[0]!)
  vi.advanceTimersByTime(60_000)
  expect(synthesis.cancel).toHaveBeenCalledOnce(); expect(events[0]?.kind).toBe('playbackError')
  lateEnd({} as SpeechSynthesisEvent); expect(events).toHaveLength(1)
})

it('waits for installed voice discovery, then speaks without an early failure', () => {
  vi.useFakeTimers()
  const { speech, synthesis, played, events } = fixture()
  synthesis.getVoices = () => []
  speech.speak({ line: 1, text: 'Bonjour', language: 'fr' }); speech.end()
  expect(played).toHaveLength(0); expect(events).toEqual([])
  synthesis.getVoices = () => [voice('French Enhanced')]
  const ready = synthesis.addEventListener.mock.calls[0]![1] as () => void
  ready(); expect(played).toHaveLength(1)
  start(played[0]!); end(played[0]!)
  vi.advanceTimersByTime(5_000)
  expect(events.at(-1)?.kind).toBe('playbackDrained')
  expect(events.some(e => e.kind === 'playbackError')).toBe(false)
})
it('cancels pending voice discovery without speaking when voices arrive late', () => {
  vi.useFakeTimers()
  const { speech, synthesis, played, events } = fixture()
  synthesis.getVoices = () => []
  speech.speak({ line: 1, text: 'Bonjour', language: 'fr' })
  const ready = synthesis.addEventListener.mock.calls[0]![1] as () => void
  speech.cancel(); synthesis.getVoices = () => [voice('French Enhanced')]; ready()
  vi.advanceTimersByTime(5_000)
  expect(played).toHaveLength(0); expect(events).toEqual([])
})
