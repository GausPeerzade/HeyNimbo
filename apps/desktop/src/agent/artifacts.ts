import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AgentStore, ArtifactMeta, ArtifactStore } from './contracts'

const clone = <T>(value: T): T => structuredClone(value)
const MAX_BYTES = 10_000_000
const MAX_META_BYTES = 16 * 1024
const ID = /^[A-Za-z0-9_-]{1,200}$/
const HASH = /^[a-f0-9]{64}$/
const UNSAFE_NAME = /[\\/\u0000-\u001f\u007f-\u009f]/g
const safeName = (name: string): string => name.replace(UNSAFE_NAME, '').replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u2028\u2029]/g, char => `⟪U+${char.charCodeAt(0).toString(16).toUpperCase()}⟫`).trim().slice(0, 200).trim() || 'artifact'
const validId = (id: string): boolean => typeof id === 'string' && ID.test(id)
const digest = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex')
function snapshot(content: Uint8Array): Uint8Array {
  if (!(content instanceof Uint8Array)) throw new Error('Invalid artifact.')
  if (content.byteLength > MAX_BYTES) throw new Error('Artifact is too large.')
  return new Uint8Array(content)
}
function metadata(runId: string, name: string, mediaType: string, content: Uint8Array): ArtifactMeta {
  if (!validId(runId) || typeof name !== 'string' || typeof mediaType !== 'string' || !mediaType.trim() || mediaType.length > 200) throw new Error('Invalid artifact.')
  return { id: randomUUID().replaceAll('-', ''), runId, name: safeName(name), mediaType, bytes: content.byteLength, sha256: digest(content), created: Date.now() }
}
function validateIds(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.some(id => !validId(id))) throw new Error('Invalid artifact.')
}
function parseMeta(value: unknown, id: string): ArtifactMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata.')
  const m = value as Record<string, unknown>
  if (Object.keys(m).some(key => !['id', 'runId', 'name', 'mediaType', 'bytes', 'sha256', 'created'].includes(key)) ||
      m.id !== id || !validId(id) || typeof m.runId !== 'string' || !validId(m.runId) ||
      typeof m.name !== 'string' || m.name !== safeName(m.name) ||
      typeof m.mediaType !== 'string' || !m.mediaType.trim() || m.mediaType.length > 200 ||
      typeof m.sha256 !== 'string' || !HASH.test(m.sha256) ||
      typeof m.bytes !== 'number' || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || m.bytes > MAX_BYTES ||
      typeof m.created !== 'number' || !Number.isSafeInteger(m.created) || m.created < 0) throw new Error('Invalid metadata.')
  return m as unknown as ArtifactMeta
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
async function directory(path: string, create: boolean): Promise<boolean> {
  let stat
  try { stat = await lstat(path) }
  catch (error) {
    if (!missing(error)) throw error
    if (!create) return false
    await mkdir(path, { recursive: true, mode: 0o700 })
    stat = await lstat(path)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid artifact directory.')
  if (create) await chmod(path, 0o700)
  return true
}
async function boundedRead(path: string, limit: number): Promise<Uint8Array | undefined> {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if (missing(error)) return undefined; throw error }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid artifact file.')
    // A one-byte sentinel detects growth without ever buffering an unbounded file.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('Artifact file changed.')
    return new Uint8Array(buffer.subarray(0, length))
  } finally { await handle.close() }
}
async function atomicWrite(path: string, content: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}

export class MemoryArtifactStore implements ArtifactStore {
  private artifacts = new Map<string, ArtifactMeta>()
  private blobs = new Map<string, { content: Uint8Array; refs: number }>()
  private bytes = 0
  constructor(private maxBytes = 50_000_000) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid artifact storage limit.')
  }
  async save(runId: string, name: string, mediaType: string, content: Uint8Array): Promise<ArtifactMeta> {
    const copy = snapshot(content), meta = metadata(runId, name, mediaType, copy)
    // Include sidecars so even a flood of empty/deduplicated saves is bounded.
    const added = Buffer.byteLength(JSON.stringify(meta)) + (this.blobs.has(meta.sha256) ? 0 : copy.byteLength)
    if (this.bytes + added > this.maxBytes) throw new Error('Temporary artifact storage is full.')
    const blob = this.blobs.get(meta.sha256) ?? { content: copy, refs: 0 }
    blob.refs++
    this.blobs.set(meta.sha256, blob)
    this.artifacts.set(meta.id, meta)
    this.bytes += added
    return clone(meta)
  }
  async read(runId: string, artifactId: string): Promise<{ meta: ArtifactMeta; content: Uint8Array } | undefined> {
    const meta = this.artifacts.get(artifactId)
    return meta?.runId === runId ? { meta: clone(meta), content: clone(this.blobs.get(meta.sha256)!.content) } : undefined
  }
  async delete(artifactIds: readonly string[]): Promise<void> {
    validateIds(artifactIds)
    for (const id of artifactIds) {
      const meta = this.artifacts.get(id)
      if (!meta) continue
      this.artifacts.delete(id)
      this.bytes -= Buffer.byteLength(JSON.stringify(meta))
      const blob = this.blobs.get(meta.sha256)!
      if (--blob.refs === 0) { this.blobs.delete(meta.sha256); this.bytes -= blob.content.byteLength }
    }
  }
}

// One host owns the directory; share a queue across its adapter instances so a
// delete cannot collect a blob between another save's blob and metadata writes.
const queues = new Map<string, Promise<void>>()
export class FileArtifactStore implements ArtifactStore {
  private dir: string
  constructor(dir: string) { this.dir = resolve(dir) }
  /** Cold startup cleanup is streamed and limited to the owned two-level layout. */
  async sweepTemporary(now: number): Promise<void> {
    return this.exclusive(async () => {
      if (!await directory(this.dir, false)) return
      const sweep = async (path: string, root: boolean): Promise<void> => {
        for await (const entry of await opendir(path)) {
          const child = join(path, entry.name)
          if (root && entry.isDirectory() && (entry.name === 'meta' || /^[a-f0-9]{2}$/.test(entry.name))) await sweep(child, false)
          else if (entry.isFile() && entry.name.endsWith('.tmp') && (await lstat(child)).mtimeMs < now - 3_600_000) await rm(child, { force: true })
        }
      }
      await sweep(this.dir, true)
    })
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.dir) ?? Promise.resolve()).then(action).catch(() => { throw new Error('Artifact unavailable.') })
    const settled = result.then(() => {}, () => {})
    queues.set(this.dir, settled)
    return result.finally(() => { if (queues.get(this.dir) === settled) queues.delete(this.dir) })
  }
  private async directories(part: string, create = false): Promise<boolean> {
    return await directory(this.dir, create) && await directory(join(this.dir, part), create)
  }
  /** Cold reconciliation; bounded batches avoid retaining all artifact hashes. */
  async sweepOrphans(referenced: (runId: string, artifactId: string) => boolean): Promise<void> {
    return this.exclusive(async () => {
      if (!await directory(this.dir, false)) return
      const hasMeta = await this.directories('meta')
      if (hasMeta) for await (const entry of await opendir(join(this.dir, 'meta'))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        let meta
        try { meta = await this.meta(entry.name.slice(0, -5)) } catch { continue }
        if (meta && !referenced(meta.runId, meta.id)) await rm(this.metaPath(meta.id), { force: true })
      }
      const collect = async (hashes: Set<string>) => {
        if (hasMeta) for await (const entry of await opendir(join(this.dir, 'meta'))) {
          if (!entry.name.endsWith('.json')) continue
          // Unknown/corrupt sidecars may own any blob: preserve rather than
          // guess. Known deletion jobs remain retryable until repaired.
          let meta
          try { meta = await this.meta(entry.name.slice(0, -5)) } catch { return }
          if (meta) hashes.delete(meta.sha256)
        }
        for (const hash of hashes) await rm(this.blobPath(hash), { force: true })
      }
      for await (const prefix of await opendir(this.dir)) {
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue
        if (!await this.directories(prefix.name)) continue
        let hashes = new Set<string>()
        for await (const entry of await opendir(join(this.dir, prefix.name))) {
          if (!entry.isFile() || !HASH.test(entry.name) || !entry.name.startsWith(prefix.name)) continue
          hashes.add(entry.name)
          if (hashes.size === 200) { await collect(hashes); hashes = new Set() }
        }
        if (hashes.size) await collect(hashes)
      }
    })
  }
  private metaPath(id: string): string { return join(this.dir, 'meta', `${id}.json`) }
  private blobPath(sha256: string): string { return join(this.dir, sha256.slice(0, 2), sha256) }
  async save(runId: string, name: string, mediaType: string, content: Uint8Array): Promise<ArtifactMeta> {
    // Snapshot before the first await, so caller mutation cannot corrupt the digest.
    const copy = snapshot(content), meta = metadata(runId, name, mediaType, copy)
    return this.exclusive(async () => {
      await this.directories('meta', true)
      await this.directories(meta.sha256.slice(0, 2), true)
      await atomicWrite(this.blobPath(meta.sha256), copy)
      await atomicWrite(this.metaPath(meta.id), JSON.stringify(meta))
      return meta
    })
  }
  private async meta(id: string): Promise<ArtifactMeta | undefined> {
    if (!validId(id)) throw new Error('Invalid artifact ID.')
    if (!await this.directories('meta')) return undefined
    const content = await boundedRead(this.metaPath(id), MAX_META_BYTES)
    return content === undefined ? undefined : parseMeta(JSON.parse(new TextDecoder().decode(content)), id)
  }
  async read(runId: string, artifactId: string): Promise<{ meta: ArtifactMeta; content: Uint8Array } | undefined> {
    if (!validId(runId) || !validId(artifactId)) return undefined
    return this.exclusive(async () => {
      const meta = await this.meta(artifactId)
      if (meta?.runId !== runId) return undefined
      if (!await this.directories(meta.sha256.slice(0, 2))) return undefined
      const content = await boundedRead(this.blobPath(meta.sha256), MAX_BYTES)
      if (content === undefined) return undefined
      if (content.byteLength !== meta.bytes || digest(content) !== meta.sha256) throw new Error('Invalid artifact content.')
      return { meta, content }
    })
  }
  async delete(artifactIds: readonly string[]): Promise<void> {
    validateIds(artifactIds)
    // Snapshot the batch before awaiting the directory queue.
    const deleting = new Set(artifactIds)
    return this.exclusive(async () => {
      const hashes = new Set<string>()
      for (const id of deleting) { const meta = await this.meta(id); if (meta) hashes.add(meta.sha256) }
      if (!hashes.size) return
      // Stream the reference scan: deletion is cold-path O(artifact count), but
      // each sidecar read is bounded and save/read never scan the artifact history.
      const entries = await opendir(join(this.dir, 'meta'))
      for await (const entry of entries) {
        if (!entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -5)
        if (deleting.has(id)) continue
        const meta = await this.meta(id)
        if (meta) hashes.delete(meta.sha256)
      }
      for (const hash of hashes) await this.directories(hash.slice(0, 2))
      // Keep the hash sidecar until blob deletion succeeds. A crash/EIO after
      // unlinking metadata would otherwise lose the only retry reference.
      for (const hash of hashes) await rm(this.blobPath(hash), { force: true })
      for (const id of deleting) await rm(this.metaPath(id), { force: true })
    })
  }
}

/** One bounded-memory pass; failed jobs stay durable for the next purge/start. */
export async function retryArtifactCleanup(store: AgentStore, artifacts: ArtifactStore): Promise<void> {
  let after: string | undefined, failed = false
  for (;;) {
    const jobs = store.cleanupJobs(after)
    if (!jobs.length) break
    for (const id of jobs) {
      try { await artifacts.delete([id]); store.completeCleanup(id) } catch { failed = true }
    }
    after = jobs.at(-1)!
  }
  if (failed) throw new Error('Artifact cleanup is pending.')
}
