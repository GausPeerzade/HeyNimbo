import { beforeEach, expect, it, vi } from 'vitest'
import { allowSpeechRecognition, selectVoiceEngine } from './engine'
const native = vi.hoisted(() => ({ availability: vi.fn(), request: vi.fn() }))
vi.mock('@nimboguide/native', () => ({ speechAvailability: native.availability, requestSpeechAuthorization: native.request }))
beforeEach(() => { vi.clearAllMocks(); native.availability.mockReturnValue({ available: true, authorization: 'authorized' }) })
it('prefers a saved OpenAI key without probing local authorization', () => {
  expect(selectVoiceEngine('synthetic')).toEqual({ engine: 'openai' })
  expect(native.availability).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled()
})
it('uses authorized on-device listening without an OpenAI key', () => {
  expect(selectVoiceEngine(undefined)).toEqual({ engine: 'builtin' })
  expect(native.request).not.toHaveBeenCalled()
})
it.each([
  ['notDetermined', 'Allow speech recognition.', true],
  ['denied', 'Permission denied.', false],
  ['restricted', 'Permission restricted.', false],
  ['unavailable', 'Missing usage descriptions.', false],
  ['authorized', 'On-device model not installed.', false],
])('reports %s listening as unavailable with its reason', (authorization, reason, needsPermission) => {
  native.availability.mockReturnValue({ available: false, authorization, reason })
  expect(selectVoiceEngine(undefined)).toEqual({ engine: 'unavailable', reason, needsPermission })
  expect(native.request).not.toHaveBeenCalled()
})
it('rejects inconsistent availability that is not authorized', () => {
  native.availability.mockReturnValue({ available: true, authorization: 'denied' })
  expect(selectVoiceEngine(undefined).engine).toBe('unavailable')
})
it('requests authorization only through the explicit action', async () => {
  native.request.mockResolvedValue('authorized')
  selectVoiceEngine(undefined)
  expect(native.request).not.toHaveBeenCalled()
  await allowSpeechRecognition()
  expect(native.request).toHaveBeenCalledOnce()
})
