import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStore } from './contracts'
import { DEFAULT_BUDGET } from '../shared/agent-protocol'
import { FileArtifactStore, MemoryArtifactStore, retryArtifactCleanup } from './artifacts'
import { SqliteAgentStore } from './store'
import { composeRuntime } from './host/compose'
import { agentPaths } from './paths'

const dirs: string[] = [], stores: AgentStore[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'heynimbo-artifact-recovery-')); dirs.push(dir); return dir }
const bytes = (value: string) => new TextEncoder().encode(value)
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.doUnmock('node:fs/promises'); vi.resetModules() })

it('keeps a durable job across deletion EIO and retries it at real host startup without removing shared content', async () => {
  const dir = temp(), paths = agentPaths(dir)
  const store = new SqliteAgentStore(paths.db)
  const artifacts = new FileArtifactStore(paths.artifacts)
  for (const id of ['remove', 'keep']) store.createRun({ id, requestId: id, goal: 'Private', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 })
  const deleted = await artifacts.save('remove', 'Private.txt', 'text/plain', bytes('shared private content'))
  const shared = await artifacts.save('keep', 'Keep.txt', 'text/plain', bytes('shared private content'))
  store.appendEvent('keep', { type: 'artifact', artifactId: shared.id, name: shared.name, mediaType: shared.mediaType, bytes: shared.bytes }, 2)
  store.appendEvent('remove', { type: 'artifact', artifactId: deleted.id, name: deleted.name, mediaType: deleted.mediaType, bytes: deleted.bytes }, 2)
  store.deleteRun('remove')
  const failing = { save: artifacts.save.bind(artifacts), read: artifacts.read.bind(artifacts), delete: async () => { throw Object.assign(new Error('Injected EIO'), { code: 'EIO' }) } }
  await expect(retryArtifactCleanup(store, failing)).rejects.toThrow('Artifact cleanup is pending.')
  expect(store.cleanupJobs()).toEqual([deleted.id])
  store.close()
  const runtime = await composeRuntime({ dataDir: dir, credentials: async () => '', sink: { events: () => {}, partial: () => {} } })
  try {
    const inspect = new SqliteAgentStore(paths.db); stores.push(inspect)
    expect(inspect.cleanupJobs()).toEqual([])
    expect(await artifacts.read('remove', deleted.id)).toBeUndefined()
    expect((await artifacts.read('keep', shared.id))?.content).toEqual(bytes('shared private content'))
  } finally { await runtime.shutdown() }
})

it.each(['blob', 'metadata'] as const)('recovers after an EIO during %s deletion without losing the last blob cleanup reference', async phase => {
  const dir = temp(), original = new FileArtifactStore(dir)
  const meta = await original.save('gone', 'Private', 'text/plain', bytes('unique private bytes'))
  const blob = join(dir, meta.sha256.slice(0, 2), meta.sha256), sidecar = join(dir, 'meta', meta.id + '.json')
  const target = phase === 'blob' ? blob : sidecar
  let failed = false
  vi.resetModules()
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === target && !failed) { failed = true; throw Object.assign(new Error('Injected EIO'), { code: 'EIO' }) }
      return actual.rm(...args)
    } }
  })
  const { FileArtifactStore: Faulted } = await import('./artifacts')
  await expect(new Faulted(dir).delete([meta.id])).rejects.toThrow('Artifact unavailable.')
  expect(existsSync(sidecar)).toBe(true)
  await new Faulted(dir).delete([meta.id])
  expect(existsSync(sidecar)).toBe(false)
  expect(existsSync(blob)).toBe(false)
})

it('collects startup artifacts saved before run/event commit and blobs saved before metadata commit', async () => {
  const dir = temp(), paths = agentPaths(dir), store = new SqliteAgentStore(paths.db)
  const artifacts = new FileArtifactStore(paths.artifacts)
  store.createRun({ id: 'keep', requestId: 'keep', goal: 'Keep', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 })
  const orphan = await artifacts.save('missing-run', 'Orphan', 'text/plain', bytes('shared'))
  const keep = await artifacts.save('keep', 'Keep', 'text/plain', bytes('shared'))
  store.appendEvent('keep', { type: 'artifact', artifactId: keep.id, name: keep.name, mediaType: keep.mediaType, bytes: keep.bytes }, 2)
  const noEvent = await artifacts.save('keep', 'Uncommitted', 'text/plain', bytes('not committed to an event'))
  const noSidecar = await artifacts.save('missing-run', 'No sidecar', 'text/plain', bytes('orphan blob'))
  rmSync(join(paths.artifacts, 'meta', noSidecar.id + '.json'))
  store.close()
  const runtime = await composeRuntime({ dataDir: dir, credentials: async () => '', sink: { events: () => {}, partial: () => {} } })
  try {
    expect(await artifacts.read('missing-run', orphan.id)).toBeUndefined()
    expect(await artifacts.read('keep', noEvent.id)).toBeUndefined()
    expect((await artifacts.read('keep', keep.id))?.content).toEqual(bytes('shared'))
    expect(existsSync(join(paths.artifacts, noSidecar.sha256.slice(0, 2), noSidecar.sha256))).toBe(false)
  } finally { await runtime.shutdown() }
})

it('bounds memory artifact storage including metadata and releases capacity only after the last shared reference', async () => {
  const store = new MemoryArtifactStore(1500)
  const first = await store.save('one', 'First', 'text/plain', new Uint8Array(800))
  const second = await store.save('two', 'Second', 'text/plain', new Uint8Array(800))
  await expect(store.save('three', 'Too much', 'text/plain', new Uint8Array(800).fill(1))).rejects.toThrow('Temporary artifact storage is full.')
  await store.delete([first.id])
  await expect(store.save('three', 'Still full', 'text/plain', new Uint8Array(800).fill(1))).rejects.toThrow('Temporary artifact storage is full.')
  await store.delete([second.id])
  expect((await store.save('three', 'Fits', 'text/plain', new Uint8Array(800).fill(1))).bytes).toBe(800)
})

it('renders bidi and Unicode line separators visibly in persisted artifact display names', async () => {
  const store = new FileArtifactStore(temp())
  const meta = await store.save('run', 'safe\u202eevil\u2066\u200f\u2028name', 'text/plain', bytes('safe'))
  expect(meta.name).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u2028\u2029]/)
  expect(meta.name).toContain('U+202E')
  expect((await store.read('run', meta.id))?.meta.name).toBe(meta.name)
})
