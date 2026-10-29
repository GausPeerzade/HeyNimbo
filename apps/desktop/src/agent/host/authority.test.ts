import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { composeRuntime } from './compose'
import { DEFAULT_BUDGET } from '../../shared/agent-protocol'

it('binds the production compatible model credential to the selected endpoint before any provider request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-model-binding-'))
  const bindings: unknown[] = []
  const runtime = await composeRuntime({ dataDir: dir, credentials: async (name, binding) => { bindings.push({ name, binding }); throw new Error('Synthetic credential denial') }, sink: { events() {}, partial() {} } })
  try {
    await runtime.handle({ kind: 'start', requestId: 'binding', goal: 'Test binding', mode: 'web', persistence: 'temporary', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'compatible', model: 'fixture', baseURL: 'https://chosen.invalid/v1' } })
    await vi.waitFor(() => expect(bindings).toHaveLength(1))
    expect(bindings).toEqual([{ name: 'compatible', binding: { baseURL: 'https://chosen.invalid/v1' } }])
  } finally { await runtime.shutdown(); rmSync(dir, { recursive: true, force: true }) }
})
