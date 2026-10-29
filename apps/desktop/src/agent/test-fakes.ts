import { randomUUID } from 'node:crypto'
import type { ArtifactMeta, ArtifactStore } from './contracts'
import { MemoryAgentStore } from './store'

/** Runtime tests share the real in-memory store contract, not a permissive imitation. */
export class FakeStore extends MemoryAgentStore {}

export class FakeArtifacts implements ArtifactStore {
  values = new Map<string, { meta: ArtifactMeta; content: Uint8Array }>()
  async save(runId: string, name: string, mediaType: string, content: Uint8Array) {
    const id = randomUUID()
    const meta = { id, runId, name, mediaType, bytes: content.byteLength, sha256: id, created: 0 }
    this.values.set(id, { meta, content })
    return meta
  }
  async read(runId: string, artifactId: string) { const value = this.values.get(artifactId); return value?.meta.runId === runId ? value : undefined }
  async delete(ids: readonly string[]) { for (const id of ids) this.values.delete(id) }
}
