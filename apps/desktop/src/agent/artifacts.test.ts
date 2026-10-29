import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { ArtifactMeta, ArtifactStore } from './contracts'
import { FileArtifactStore, MemoryArtifactStore } from './artifacts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'heynimbo-artifacts-')); dirs.push(dir); return dir }
const bytes = (text: string) => new TextEncoder().encode(text)
const text = (content: Uint8Array | undefined) => content === undefined ? undefined : new TextDecoder().decode(content)
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

describe.each([
  ['file', (): ArtifactStore => new FileArtifactStore(join(temp(), 'artifacts'))],
  ['memory', (): ArtifactStore => new MemoryArtifactStore()],
] as const)('%s ArtifactStore contract', (_, create) => {
  it('saves immutable content under an opaque ID and denies cross-run reads', async () => {
    const store = create(), content = bytes('A private report')
    const meta = await store.save('run_1', 'Report.txt', 'text/plain', content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    expect(meta).toMatchObject({ runId: 'run_1', name: 'Report.txt', mediaType: 'text/plain', bytes: content.length, sha256 })
    expect(meta.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(meta.id).not.toBe(meta.sha256)
    expect(meta.created).toBeGreaterThan(0)
    const saved = await store.read('run_1', meta.id)
    expect(saved?.meta).toEqual(meta)
    expect(text(saved?.content)).toBe('A private report')
    expect(await store.read('run_2', meta.id)).toBeUndefined()
    expect(await store.read('run_1', 'missing')).toBeUndefined()
  })
  it('sanitizes display names without ever treating them as filesystem paths', async () => {
    const store = create()
    const hostile = '../\\outside\u0000\n\u007f\u0085' + 'x'.repeat(250)
    const meta = await store.save('run_1', hostile, 'text/plain', bytes('safe'))
    expect(meta.name).not.toMatch(/[\\/\u0000-\u001f\u007f-\u009f]/)
    expect(meta.name.length).toBeLessThanOrEqual(200)
    expect(text((await store.read('run_1', meta.id))?.content)).toBe('safe')
    const unnamed = await store.save('run_1', '/\\\u0000 ', 'text/plain', bytes('empty name'))
    expect(unnamed.name).toBe('artifact')
  })
  it('rejects content above 10 MB while preserving empty and exact-boundary artifacts', async () => {
    const store = create(), limit = 10_000_000
    await expect(store.save('run_1', 'too large', 'application/octet-stream', new Uint8Array(limit + 1))).rejects.toThrow('Artifact is too large.')
    const empty = await store.save('run_1', 'Empty', 'text/plain', new Uint8Array())
    expect((await store.read('run_1', empty.id))?.content).toHaveLength(0)
    const boundary = await store.save('run_1', 'Boundary', 'application/octet-stream', new Uint8Array(limit).fill(7))
    expect((await store.read('run_1', boundary.id))?.content).toHaveLength(limit)
  })
  it('truncates whitespace at the display-name boundary without making metadata unreadable', async () => {
    const store = create()
    const meta = await store.save('run_1', 'x'.repeat(199) + ' tail', 'text/plain', bytes('safe'))
    expect(meta.name).toBe('x'.repeat(199))
    expect(text((await store.read('run_1', meta.id))?.content)).toBe('safe')
  })
  it('deletes references idempotently without removing content still owned by another artifact', async () => {
    const store = create(), content = bytes('Shared content')
    const first = await store.save('run_1', 'First', 'text/plain', content)
    const second = await store.save('run_2', 'Second', 'text/plain', content)
    expect(first.id).not.toBe(second.id)
    expect(first.sha256).toBe(second.sha256)
    await store.delete([first.id, first.id, 'missing'])
    expect(await store.read('run_1', first.id)).toBeUndefined()
    expect(text((await store.read('run_2', second.id))?.content)).toBe('Shared content')
    await store.delete([second.id])
    expect(await store.read('run_2', second.id)).toBeUndefined()
    await expect(store.delete([])).resolves.toBeUndefined()
    await expect(store.delete([second.id])).resolves.toBeUndefined()
  })
  it('keeps concurrent identical saves readable while an earlier reference is deleted', async () => {
    const store = create(), content = bytes('Shared concurrent content')
    const first = await store.save('run_1', 'Old', 'text/plain', content)
    const replacements = Array.from({ length: 12 }, (_, i) => store.save(`run_${i + 2}`, 'New', 'text/plain', content))
    let saved: ArtifactMeta[]
    try { await store.delete([first.id]); saved = await Promise.all(replacements) }
    finally { await Promise.allSettled(replacements) }
    for (const meta of saved) expect(text((await store.read(meta.runId, meta.id))?.content)).toBe('Shared concurrent content')
    await store.delete(saved.map(meta => meta.id))
    for (const meta of saved) expect(await store.read(meta.runId, meta.id)).toBeUndefined()
  })
  it('snapshots caller-owned byte arrays and returns detached metadata and read buffers', async () => {
    const store = create(), content = bytes('Original')
    const pending = store.save('run_1', 'Original.txt', 'text/plain', content)
    content.fill(0)
    const meta = await pending, id = meta.id
    meta.runId = 'attacker'
    meta.name = 'Changed'
    const first = (await store.read('run_1', id))!
    expect(text(first.content)).toBe('Original')
    first.content.fill(0)
    first.meta.name = 'Changed again'
    const second = (await store.read('run_1', id))!
    expect(second.meta.name).toBe('Original.txt')
    expect(text(second.content)).toBe('Original')
  })
  it('rejects invalid owner IDs and media types before saving an artifact', async () => {
    const store = create()
    await expect(store.save('../run', 'Name', 'text/plain', bytes('safe'))).rejects.toThrow('Invalid artifact.')
    await expect(store.save('run_1', 'Name', '', bytes('safe'))).rejects.toThrow('Invalid artifact.')
    await expect(store.save('run_1', 'Name', 'a'.repeat(201), bytes('safe'))).rejects.toThrow('Invalid artifact.')
    await expect(store.save('run_1', 'Name', 'text/plain', null as unknown as Uint8Array)).rejects.toThrow('Invalid artifact.')
  })
  it('validates deletion batches before removing references and denies invalid read identifiers', async () => {
    const store = create(), meta = await store.save('run_1', 'Report', 'text/plain', bytes('safe'))
    await expect(store.delete([meta.id, '../escape'])).rejects.toThrow('Invalid artifact.')
    expect(text((await store.read('run_1', meta.id))?.content)).toBe('safe')
    expect(await store.read('../run', meta.id)).toBeUndefined()
    expect(await store.read('run_1', '../escape')).toBeUndefined()
  })
})

it('executes temporary artifact storage with filesystem access denied and creates no files', async () => {
  const dir = temp(), before = readdirSync(dir)
  vi.resetModules()
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' ? () => { throw new Error('Filesystem access denied.') } : value]))
  })
  try {
    const { MemoryArtifactStore: MemoryOnly } = await import('./artifacts')
    const store = new MemoryOnly(), meta = await store.save('run_1', 'Private', 'text/plain', bytes('No disk writes'))
    expect(text((await store.read('run_1', meta.id))?.content)).toBe('No disk writes')
    await store.delete([meta.id])
    expect(await store.read('run_1', meta.id)).toBeUndefined()
    expect(readdirSync(dir)).toEqual(before)
  } finally { vi.doUnmock('node:fs/promises'); vi.resetModules() }
})

describe('FileArtifactStore disk safety', () => {
  const blob = (dir: string, meta: ArtifactMeta) => join(dir, meta.sha256.slice(0, 2), meta.sha256)
  const sidecar = (dir: string, meta: ArtifactMeta) => join(dir, 'meta', `${meta.id}.json`)
  it('reopens private content-addressed files and collects a blob only after its last reference is deleted', async () => {
    const dir = join(temp(), 'artifacts')
    mkdirSync(dir, { mode: 0o777 })
    chmodSync(dir, 0o777)
    const first = new FileArtifactStore(dir)
    const a = await first.save('run_1', '../../Report.txt', 'text/plain', bytes('deduplicated'))
    const b = await first.save('run_2', 'Other.txt', 'text/plain', bytes('deduplicated'))
    for (const path of [dir, join(dir, 'meta'), join(dir, a.sha256.slice(0, 2))]) expect(statSync(path).mode & 0o777).toBe(0o700)
    for (const path of [blob(dir, a), sidecar(dir, a), sidecar(dir, b)]) expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, a.sha256.slice(0, 2)))).toEqual([a.sha256])
    expect(readdirSync(dir, { recursive: true }).some(name => String(name).endsWith('.tmp'))).toBe(false)
    const reopened = new FileArtifactStore(dir)
    expect(text((await reopened.read('run_1', a.id))?.content)).toBe('deduplicated')
    await reopened.delete([a.id])
    expect(existsSync(blob(dir, b))).toBe(true)
    expect(existsSync(sidecar(dir, a))).toBe(false)
    await first.delete([b.id])
    expect(existsSync(blob(dir, b))).toBe(false)
  })
  it('denies artifact ID traversal on reads and validates an entire delete batch before removing anything', async () => {
    const dir = join(temp(), 'artifacts'), store = new FileArtifactStore(dir)
    const meta = await store.save('run_1', 'Report', 'text/plain', bytes('private'))
    writeFileSync(join(dir, 'escape.json'), JSON.stringify({ ...meta, id: '../escape' }))
    expect(await store.read('run_1', '../escape')).toBeUndefined()
    await expect(store.delete([meta.id, '../escape'])).rejects.toThrow('Invalid artifact.')
    expect(text((await store.read('run_1', meta.id))?.content)).toBe('private')
    expect(existsSync(join(dir, 'escape.json'))).toBe(true)
  })
  it('rejects malformed metadata and hash traversal instead of returning an unrelated file', async () => {
    const dir = join(temp(), 'artifacts'), store = new FileArtifactStore(dir)
    const meta = await store.save('run_1', 'Report', 'text/plain', bytes('private'))
    writeFileSync(join(dir, 'secret'), 'outside')
    writeFileSync(sidecar(dir, meta), JSON.stringify({ ...meta, sha256: 'ab/../../secret' }))
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
    writeFileSync(sidecar(dir, meta), '{malformed')
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
    writeFileSync(sidecar(dir, meta), ' '.repeat(16_385))
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
  })
  it('rejects modified or oversized blobs instead of trusting sidecar size and digest claims', async () => {
    const dir = join(temp(), 'artifacts'), store = new FileArtifactStore(dir)
    const meta = await store.save('run_1', 'Report', 'text/plain', bytes('private'))
    writeFileSync(blob(dir, meta), 'changed')
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
    truncateSync(blob(dir, meta), 10_000_001)
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
  })
  it('refuses symlink blobs and metadata that point outside the artifact directory', async () => {
    const dir = join(temp(), 'artifacts'), store = new FileArtifactStore(dir), outside = join(temp(), 'secret')
    const meta = await store.save('run_1', 'Report', 'text/plain', bytes('private'))
    // Equal content defeats digest-only checks: following this link must still fail.
    writeFileSync(outside, 'private')
    rmSync(blob(dir, meta))
    symlinkSync(outside, blob(dir, meta))
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
    rmSync(sidecar(dir, meta))
    const outsideMeta = join(temp(), 'meta.json')
    writeFileSync(outsideMeta, JSON.stringify(meta))
    symlinkSync(outsideMeta, sidecar(dir, meta))
    await expect(store.read('run_1', meta.id)).rejects.toThrow('Artifact unavailable.')
    expect(readFileSync(outside, 'utf8')).toBe('private')
  })
  it.each(['root', 'prefix', 'meta'] as const)('refuses a symlink %s directory before writing outside its storage root', async target => {
    const dir = join(temp(), 'artifacts'), outside = temp(), content = bytes('private')
    const sha = createHash('sha256').update(content).digest('hex')
    if (target !== 'root') mkdirSync(dir)
    symlinkSync(outside, target === 'root' ? dir : join(dir, target === 'prefix' ? sha.slice(0, 2) : 'meta'))
    await expect(new FileArtifactStore(dir).save('run_1', 'Report', 'text/plain', content)).rejects.toThrow('Artifact unavailable.')
    expect(readdirSync(outside)).toEqual([])
  })
  it('fails closed on corrupt reference metadata and preserves all surviving content', async () => {
    const dir = join(temp(), 'artifacts'), store = new FileArtifactStore(dir)
    const a = await store.save('run_1', 'A', 'text/plain', bytes('shared'))
    const b = await store.save('run_2', 'B', 'text/plain', bytes('shared'))
    writeFileSync(sidecar(dir, b), '{corrupt')
    await expect(store.delete([a.id])).rejects.toThrow('Artifact unavailable.')
    expect(existsSync(blob(dir, a))).toBe(true)
    expect(text((await store.read('run_1', a.id))?.content)).toBe('shared')
  })
  it('cleans failed atomic writes and recovers its queue for a subsequent save', async () => {
    const dir = join(temp(), 'artifacts'), store = new FileArtifactStore(dir), content = bytes('private')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const blocked = join(dir, sha256.slice(0, 2), sha256)
    // A directory at the final blob path forces rename to fail after temp write.
    mkdirSync(blocked, { recursive: true })
    await expect(store.save('run_1', 'Blocked', 'text/plain', content)).rejects.toThrow('Artifact unavailable.')
    expect(readdirSync(dir, { recursive: true }).some(name => String(name).endsWith('.tmp'))).toBe(false)
    rmSync(blocked, { recursive: true })
    const meta = await store.save('run_1', 'Recovered', 'text/plain', content)
    expect(text((await store.read('run_1', meta.id))?.content)).toBe('private')
  })
})
