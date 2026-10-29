import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStore, NewRun } from './contracts'
import { DEFAULT_BUDGET } from '../shared/agent-protocol'
import { MemoryAgentStore, SqliteAgentStore } from './store'

const dirs: string[] = [], stores: AgentStore[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'heynimbo-hard-store-')); dirs.push(dir); return dir }
const run = (id = 'run'): NewRun => ({ id, requestId: id, goal: 'Finish safely', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 100 })
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe.each([
  ['memory', () => new MemoryAgentStore()],
  ['SQLite', () => new SqliteAgentStore(join(temp(), 'agent.sqlite'))],
] as const)('%s explicit resume', (_, make) => {
  const create = () => { const store = make(); stores.push(store); return store }
  it('requires explicit resume rather than generic status mutation for provider failures', () => {
    const store = create()
    store.createRun(run())
    store.setStatus('run', 'failed', 120, { code: 'provider', message: 'Connection unavailable.' })
    expect(() => store.setStatus('run', 'running', 130)).toThrow('Run is terminal.')
    store.resume('run', 140)
    expect(store.getRun('run')?.status).toBe('running')
  })
  it.each(['interrupted', 'failed'] as const)('atomically resumes %s while preserving checkpoints, usage and grants', status => {
    const store = create()
    store.createRun(run())
    store.addUsage('run', { inputTokens: 7, outputTokens: 9 }, 110)
    store.saveCheckpoint({ runId: 'run', step: 2, messages: '[]', at: 111 })
    store.setStatus('run', status, 120, { code: 'provider', message: 'Connection unavailable.' })
    const before = store.getRun('run')!
    store.resume('run', 130)
    expect(store.getRun('run')).toEqual({ ...before, status: 'running', updated: 130, error: undefined })
    expect(store.latestCheckpoint('run')?.step).toBe(2)
    expect(() => store.resume('run', 140)).toThrow('Only an interrupted or provider-failed run can continue.')
    expect(store.getRun('run')?.updated).toBe(130)
  })
  it.each(['queued', 'running', 'waiting_user', 'waiting_approval', 'succeeded', 'cancelled', 'failed'] as const)('rejects resume of %s without mutating the record', status => {
    const store = create()
    store.createRun(run())
    store.setStatus('run', status, 120, { code: 'budget', message: 'Budget exhausted.' })
    const before = store.getRun('run')
    expect(() => store.resume('run', 130)).toThrow('Only an interrupted or provider-failed run can continue.')
    expect(store.getRun('run')).toEqual(before)
    expect(() => store.resume('missing', 130)).toThrow('Run not found.')
    expect(() => store.resume('run', -1)).toThrow('Invalid store value.')
  })
})
