import { expect, it, vi } from 'vitest'
import type { AnswerOptions } from '../answer-provider'
const seen = vi.hoisted(() => ({ options: [] as AnswerOptions[] }))
vi.mock('../answer-provider', () => ({ streamProviderAnswer: async function* (options: AnswerOptions) { seen.options.push(options); yield 'offline' } }))
import { INSTRUCTIONS, TASK_INSTRUCTIONS, streamAnswer } from './brain'

async function instructionsFor(tasks: boolean | undefined): Promise<string> {
  seen.options.length = 0
  const text: string[] = []
  for await (const delta of streamAnswer({ connection: { provider: 'compatible', model: 'offline', vision: true, credential: async () => '' }, question: 'Research', history: [], signal: new AbortController().signal, ...(tasks === undefined ? {} : { tasks }) })) text.push(delta)
  expect(text).toEqual(['offline'])
  expect(seen.options).toHaveLength(1)
  expect(seen.options[0]).not.toHaveProperty('tasks')
  return seen.options[0]!.instructions
}
it('offers the real @task protocol to the provider only when the caller can start tasks', async () => {
  expect(TASK_INSTRUCTIONS).toContain('@task web "')
  expect(TASK_INSTRUCTIONS).toContain('@task files "')
  expect(await instructionsFor(true)).toBe(INSTRUCTIONS + TASK_INSTRUCTIONS)
  for (const tasks of [false, undefined]) {
    const instructions = await instructionsFor(tasks)
    expect(instructions).toBe(INSTRUCTIONS)
    expect(instructions).not.toContain('@task')
  }
})
