import { expect, it, vi } from 'vitest'
import { BuiltInMouth } from './builtin-mouth'
const native = vi.hoisted(() => ({ language: vi.fn(() => 'fr') }))
vi.mock('@heynimbo/native', () => ({ speechLanguage: native.language }))
it('queues text with its detected language and sentence line, without producing PCM', async () => {
  const audio = { send: vi.fn() }, pcm = vi.fn(), mouth = new BuiltInMouth(audio)
  mouth.warm(); expect(audio.send).not.toHaveBeenCalled()
  await mouth.speak('Bonjour.', pcm, 4)
  expect(native.language).toHaveBeenCalledWith('Bonjour.')
  expect(audio.send).toHaveBeenCalledWith({ kind: 'systemSpeak', text: 'Bonjour.', line: 4, language: 'fr' })
  expect(pcm).not.toHaveBeenCalled()
  mouth.cancel(); expect(audio.send).toHaveBeenLastCalledWith({ kind: 'playCancel' })
  mouth.close(); expect(audio.send).toHaveBeenLastCalledWith({ kind: 'playCancel' })
})
