import { expect, it } from 'vitest'
import { ConversationController } from './conversations'
import { HistoryRepository } from './history'
import { DEFAULT_SETTINGS } from './settings'

it('owns continuity: opening selects the correct six complete turns, and New resets context', () => {
  const r = new HistoryRepository(), c = new ConversationController(r, () => DEFAULT_SETTINGS)
  try {
    const first = c.newConversation()
    for (let i = 0; i < 8; i++) {
      const t = c.begin(`Question ${i}`, 'voice')
      c.update(t, `Answer ${i}`, { version: 1, beats: [] }, true)
      c.finish(t, 'complete')
    }
    const t = c.begin('partial', 'voice'); c.finish(t, 'interrupted')
    expect(c.context()).toHaveLength(6)
    expect(c.context()[0]?.question).toBe('Question 2')
    c.newConversation()
    expect(c.context()).toEqual([])
    c.open(first)
    expect(c.context().at(-1)?.answer).toBe('Answer 7')
  } finally { c.close() }
})
it('temporary mode never writes questions, scenes or search rows to the persistent repository', () => {
  const r = new HistoryRepository(), c = new ConversationController(r, () => ({ ...DEFAULT_SETTINGS, saveHistory: false }))
  try {
    const t = c.begin('private question', 'text')
    c.update(t, 'private answer', { version: 1, beats: [] }, true); c.finish(t, 'complete')
    expect(c.context()).toEqual([{ question: 'private question', answer: 'private answer' }])
    expect(c.search('private')).toHaveLength(1)
    expect(r.list()).toEqual([])
    expect(r.search('private')).toEqual([])
  } finally { c.close() }
})
it('starts fresh after a restart, and continues old context only after an explicit open', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const dir = mkdtempSync('/tmp/heynimbo-conversation-restart-'), path = `${dir}/history.sqlite`
  try {
    const before = new ConversationController(new HistoryRepository(path), () => DEFAULT_SETTINGS)
    const old = before.newConversation(), t = before.begin('Old question', 'voice')
    before.update(t, 'Old answer', { version: 1, beats: [] }, false); before.finish(t, 'complete'); before.close()
    const after = new ConversationController(new HistoryRepository(path), () => DEFAULT_SETTINGS)
    try {
      expect(after.currentId).toBeNull()
      expect(after.context()).toEqual([])
      const next = after.begin('New voice question', 'voice')
      expect(after.currentId).not.toBe(old)
      expect(after.turns().map(t => t.question)).toEqual(['New voice question'])
      after.finish(next, 'complete')
      after.open(old)
      expect(after.context()).toEqual([{ question: 'Old question', answer: 'Old answer' }])
    } finally { after.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('loads brain context directly without decoding full transcripts or drawing scenes', () => {
  const r = new HistoryRepository(), c = new ConversationController(r, () => DEFAULT_SETTINGS)
  try {
    c.newConversation()
    for (let i = 0; i < 10; i++) { const t = c.begin(`Q${i}`, 'text'); c.update(t, `A${i}`, { version: 1, beats: [] }, false); c.finish(t, 'complete') }
    const turns = r.turns
    r.turns = () => { throw new Error('Full transcript must not be read for brain context') }
    expect(c.context()).toEqual(Array.from({ length: 6 }, (_, i) => ({ question: `Q${i + 4}`, answer: `A${i + 4}` })))
    r.turns = turns
  } finally { c.close() }
})
