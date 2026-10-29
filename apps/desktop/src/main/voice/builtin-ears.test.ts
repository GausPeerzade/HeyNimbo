import { beforeEach, expect, it, vi } from 'vitest'
import { BuiltInEars } from './builtin-ears'
const native = vi.hoisted(() => ({ construct: vi.fn() }))
vi.mock('@nimboguide/native', () => ({ SpeechSession: vi.fn(function () { return native.construct() }) }))
beforeEach(() => vi.clearAllMocks())
function fixture() {
  let resolve!: (text: string) => void
  const session = { append: vi.fn(), finish: vi.fn(() => new Promise<string>(r => { resolve = r })), cancel: vi.fn() }
  native.construct.mockReturnValue(session)
  return { ears: new BuiltInEars(), session, resolve: (text: string) => resolve(text) }
}
it('starts per hold and feeds captured PCM in order before finishing', async () => {
  const { ears, session, resolve } = fixture()
  ears.warm(); expect(native.construct).not.toHaveBeenCalled()
  ears.begin(); ears.append(new Uint8Array([1, 2])); ears.append(new Uint8Array([3, 4]))
  const result = ears.finish()
  expect(session.append.mock.calls).toEqual([[Buffer.from([1, 2])], [Buffer.from([3, 4])]])
  expect(session.append.mock.invocationCallOrder.at(-1)!).toBeLessThan(session.finish.mock.invocationCallOrder[0]!)
  resolve('  A local question  '); expect(await result).toBe('A local question')
  expect(session.cancel).toHaveBeenCalledOnce()
})
it('cancel resolves promptly and a late transcript cannot answer a new hold', async () => {
  const { ears, session, resolve } = fixture()
  ears.begin(); const result = ears.finish()
  ears.cancel(); expect(await result).toBe('')
  expect(session.cancel).toHaveBeenCalledOnce()
  ears.begin(); resolve('stale question')
  ears.append(new Uint8Array([5, 6]))
  expect(session.append).toHaveBeenCalledOnce()
  ears.close()
})
it('drops append after cancel and returns an empty result for no speech', async () => {
  const { ears, session, resolve } = fixture()
  ears.begin(); const result = ears.finish(); resolve('   ')
  expect(await result).toBe('')
  ears.cancel(); ears.append(new Uint8Array([1, 2]))
  expect(session.append).not.toHaveBeenCalled(); expect(await ears.finish()).toBe('')
})
it('reports authorization denial without trying to append or finish', async () => {
  const { ears, session } = fixture()
  native.construct.mockImplementationOnce(() => { throw new Error('Speech recognition was denied.') })
  ears.begin(); ears.append(new Uint8Array([1, 2]))
  await expect(ears.finish()).rejects.toThrow('denied')
  expect(session.append).not.toHaveBeenCalled(); expect(session.finish).not.toHaveBeenCalled()
})
it('cancels a failed append and propagates failure instead of transcribing partial input', async () => {
  const { ears, session } = fixture()
  session.append.mockImplementationOnce(() => { throw new Error('Invalid PCM') })
  ears.begin(); ears.append(new Uint8Array([1]))
  await expect(ears.finish()).rejects.toThrow('Invalid PCM')
  expect(session.finish).not.toHaveBeenCalled(); expect(session.cancel).toHaveBeenCalledOnce()
})
it('does not let an interrupted finish tear down the replacement session', async () => {
  const { ears, resolve } = fixture()
  ears.begin(); const old = ears.finish()
  const replacement = { append: vi.fn(), finish: vi.fn(async () => 'new question'), cancel: vi.fn() }
  native.construct.mockReturnValueOnce(replacement)
  ears.cancel(); ears.begin()
  expect(await old).toBe(''); resolve('late old question')
  ears.append(new Uint8Array([7, 8]))
  expect(replacement.append).toHaveBeenCalledWith(Buffer.from([7, 8]))
  expect(replacement.cancel).not.toHaveBeenCalled()
  expect(await ears.finish()).toBe('new question')
})
