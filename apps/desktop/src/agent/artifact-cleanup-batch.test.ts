import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_BUDGET } from '../shared/agent-protocol'
import type { AgentStore, ArtifactMeta } from './contracts'
import { FileArtifactStore, retryArtifactCleanup } from './artifacts'
import { SqliteAgentStore } from './store'
import { agentPaths } from './paths'

const dirs: string[] = [], stores: AgentStore[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'heynimbo-cleanup-batch-')); dirs.push(dir); return dir }
const bytes = (text: string) => new TextEncoder().encode(text)
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.doUnmock('node:fs/promises'); vi.resetModules() })
function createRun(store: AgentStore, id: string) { store.createRun({ id, requestId: id, goal: 'Synthetic cleanup', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 }) }
function reference(store: AgentStore, meta: ArtifactMeta) { store.appendEvent(meta.runId, { type: 'artifact', artifactId: meta.id, name: meta.name, mediaType: meta.mediaType, bytes: meta.bytes }, 2) }
function countReads(artifacts: FileArtifactStore) {
  // Instrument the real bounded reader, retaining actual sidecar/filesystem IO.
  const reader = artifacts as unknown as { meta(id: string): Promise<ArtifactMeta | undefined> }
  return vi.spyOn(reader, 'meta')
}

it('deletes a 200-artifact cleanup page with one shared-reference scan and at most 400 sidecar reads', async () => {
  const paths = agentPaths(temp()), store = new SqliteAgentStore(paths.db), artifacts = new FileArtifactStore(paths.artifacts)
  stores.push(store); createRun(store, 'remove')
  const metas: ArtifactMeta[] = []
  for (let i = 0; i < 200; i++) { const meta = await artifacts.save('remove', 'Tiny', 'text/plain', bytes(`unique-${i}`)); metas.push(meta); reference(store, meta) }
  store.deleteRun('remove')
  const reader = countReads(artifacts), batches = vi.spyOn(artifacts, 'delete')
  await retryArtifactCleanup(store, artifacts)
  console.info(`cleanup sidecar reads: ${reader.mock.calls.length}/200 artifacts`)
  expect(reader.mock.calls.length).toBeLessThanOrEqual(400)
  expect(batches.mock.calls.map(([ids]) => ids.length)).toEqual([200])
  expect(store.cleanupJobs()).toEqual([])
  for (const meta of metas) {
    expect(existsSync(join(paths.artifacts, 'meta', `${meta.id}.json`))).toBe(false)
    expect(existsSync(join(paths.artifacts, meta.sha256.slice(0, 2), meta.sha256))).toBe(false)
  }
})

it('scans each sidecar once during orphan GC while preserving live shared blobs', async () => {
  const artifacts = new FileArtifactStore(temp()), metas: ArtifactMeta[] = []
  for (let i = 0; i < 200; i++) metas.push(await artifacts.save(i % 2 ? 'keep' : 'orphan', 'Tiny', 'text/plain', bytes(`unique-${i}`)))
  const shared = await artifacts.save('orphan', 'Shared', 'text/plain', bytes('shared'))
  const keep = await artifacts.save('keep', 'Shared', 'text/plain', bytes('shared'))
  const reader = countReads(artifacts)
  await artifacts.sweepOrphans(runId => runId === 'keep')
  console.info(`orphan sidecar reads: ${reader.mock.calls.length}/202 artifacts`)
  expect(reader.mock.calls.length).toBe(202)
  expect((await artifacts.read('keep', keep.id))?.content).toEqual(bytes('shared'))
  expect(await artifacts.read('orphan', shared.id)).toBeUndefined()
  for (const meta of [metas[0]!, metas[1]!]) expect(!!await artifacts.read(meta.runId, meta.id)).toBe(meta.runId === 'keep')
})

it('falls back only within a failed page, retains a mid-batch EIO job across restart and preserves shared content', async () => {
  const dir = temp(), paths = agentPaths(dir), store = new SqliteAgentStore(paths.db), original = new FileArtifactStore(paths.artifacts)
  stores.push(store)
  createRun(store, 'remove'); createRun(store, 'keep')
  const metas: ArtifactMeta[] = []
  for (let i = 0; i < 201; i++) { const meta = await original.save('remove', 'Tiny', 'text/plain', bytes(`unique-${i}`)); metas.push(meta); reference(store, meta) }
  const shared = await original.save('keep', 'Keep', 'text/plain', bytes('unique-0')); reference(store, shared)
  store.deleteRun('remove')
  const sorted = metas.sort((a, b) => a.id < b.id ? -1 : 1), failed = sorted[100]!
  const target = join(paths.artifacts, failed.sha256.slice(0, 2), failed.sha256)
  vi.resetModules()
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === target) throw Object.assign(new Error('Injected EIO'), { code: 'EIO' })
      return actual.rm(...args)
    } }
  })
  const { FileArtifactStore: Faulted, retryArtifactCleanup: retry } = await import('./artifacts')
  const faulted = new Faulted(paths.artifacts), batches = vi.spyOn(faulted, 'delete')
  await expect(retry(store, faulted)).rejects.toThrow('Artifact cleanup is pending.')
  expect(batches.mock.calls.map(([ids]) => ids.length)).toEqual([200, ...Array<number>(200).fill(1), 1])
  expect(store.cleanupJobs()).toEqual([failed.id])
  expect(existsSync(join(paths.artifacts, 'meta', `${failed.id}.json`))).toBe(true)
  expect(existsSync(target)).toBe(true)
  expect((await original.read('keep', shared.id))?.content).toEqual(bytes('unique-0'))
  store.close()
  vi.doUnmock('node:fs/promises'); vi.resetModules()
  const { composeRuntime: restart } = await import('./host/compose')
  const runtime = await restart({ dataDir: dir, credentials: async () => '', sink: { events: () => {}, partial: () => {} } })
  try {
    const inspect = new SqliteAgentStore(paths.db); stores.push(inspect)
    expect(inspect.cleanupJobs()).toEqual([])
    expect(await original.read('remove', failed.id)).toBeUndefined()
    expect(existsSync(target)).toBe(false)
    expect((await original.read('keep', shared.id))?.content).toEqual(bytes('unique-0'))
  } finally { await runtime.shutdown() }
  // ~400 real rm calls plus a restart: ~2.5 s alone, much slower when the suite saturates the disk.
}, 30_000)
