import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ArtifactMeta, ArtifactStore } from './contracts'

const clone = <T>(value: T): T => structuredClone(value)
const MAX_BYTES = 10_000_000
const MAX_META_BYTES = 16 * 1024
const ID = /^[A-Za-z0-9_-]{1,200}$/
const HASH = /^[a-f0-9]{64}$/
const UNSAFE_NAME = /[\\/\u0000-\u001f\u007f-\u009f]/g
const safeName = (name: string): string => name.replace(UNSAFE_NAME, '').trim().slice(0, 200).trim() || 'artifact'
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
  async save(runId: string, name: string, mediaType: string, content: Uint8Array): Promise<ArtifactMeta> {
    const copy = snapshot(content), meta = metadata(runId, name, mediaType, copy)
    const blob = this.blobs.get(meta.sha256) ?? { content: copy, refs: 0 }
    blob.refs++
    this.blobs.set(meta.sha256, blob)
    this.artifacts.set(meta.id, meta)
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
      const blob = this.blobs.get(meta.sha256)!
      if (--blob.refs === 0) this.blobs.delete(meta.sha256)
    }
  }
}

// One host owns the directory; share a queue across its adapter instances so a
// delete cannot collect a blob between another save's blob and metadata writes.
const queues = new Map<string, Promise<void>>()
export class FileArtifactStore implements ArtifactStore {
  private dir: string
  constructor(dir: string) { this.dir = resolve(dir) }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.dir) ?? Promise.resolve()).then(action).catch(() => { throw new Error('Artifact unavailable.') })
    const settled = result.then(() => {}, () => {})
    queues.set(this.dir, settled)
    return result.finally(() => { if (queues.get(this.dir) === settled) queues.delete(this.dir) })
  }
  private async directories(part: string, create = false): Promise<boolean> {
    return await directory(this.dir, create) && await directory(join(this.dir, part), create)
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
      for (const id of deleting) await rm(this.metaPath(id), { force: true })
      for (const hash of hashes) await rm(this.blobPath(hash), { force: true })
    })
  }
}
