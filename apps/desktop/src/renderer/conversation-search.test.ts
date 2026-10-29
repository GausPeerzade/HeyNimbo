import { afterEach, expect, it, vi } from 'vitest'
import { ConversationSearch } from './conversation-search'
import type { SearchHit } from '../shared/app'
afterEach(() => vi.useRealTimers())
it('invalidates old results immediately on edits and clear, even before the next debounce dispatch', async () => {
  vi.useFakeTimers()
  let query = 'export', resolve!: (hits: SearchHit[]) => void
  const fetch = vi.fn(() => new Promise<SearchHit[]>(done => { resolve = done })), show = vi.fn()
  const search = new ConversationSearch(() => query, fetch, show)
  search.changed(); await vi.advanceTimersByTimeAsync(120)
  query = 'warning'; search.changed()
  query = 'export'; search.changed()
  resolve([]); await vi.advanceTimersByTimeAsync(0)
  expect(show).not.toHaveBeenCalled()
  query = ''; search.changed()
  expect(show).toHaveBeenCalledOnce(); expect(show).toHaveBeenLastCalledWith(undefined)
  await vi.advanceTimersByTimeAsync(120); expect(fetch).toHaveBeenCalledOnce()
})
it('also checks the live field value before applying a result', async () => {
  vi.useFakeTimers()
  let query = 'export', resolve!: (hits: SearchHit[]) => void
  const show = vi.fn(), search = new ConversationSearch(() => query, () => new Promise(done => { resolve = done }), show)
  search.changed(); await vi.advanceTimersByTimeAsync(120)
  query = 'changed without dispatch'; resolve([]); await vi.advanceTimersByTimeAsync(0)
  expect(show).not.toHaveBeenCalled()
})
