import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, truncate, readdir, symlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, ArtifactMeta, ArtifactStore, ToolContext } from '../contracts'
import { localTools, artifactTools } from './files'

// The persistence implementation is owned by another workstream. This fake is
// the true artifact boundary and deliberately cannot write into a folder grant.
class TestArtifacts implements ArtifactStore {
  readonly entries = new Map<string, { meta: ArtifactMeta; content: Uint8Array }>()
  async save(runId: string, name: string, mediaType: string, content: Uint8Array): Promise<ArtifactMeta> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const meta = { id: sha256, runId, name, mediaType, bytes: content.byteLength, sha256, created: 1 }
    this.entries.set(meta.id, { meta, content: Uint8Array.from(content) })
    return meta
  }
  async read(runId: string, artifactId: string) {
    const entry = this.entries.get(artifactId)
    return entry?.meta.runId === runId ? entry : undefined
  }
  async delete(ids: readonly string[]): Promise<void> { for (const id of ids) this.entries.delete(id) }
}

let dir: string
let root: string
let ctx: ToolContext
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heynimbo-files-'))
  root = join(dir, 'project')
  await mkdir(root)
  ctx = { runId: 'run1', grants: [{ id: 'g1', root, label: 'project' }], signal: new AbortController().signal, checkpoint() {}, artifacts: new TestArtifacts(), outputBudget: 100_000 }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
function tool(name: string): AgentTool {
  const found = [...localTools(), ...artifactTools()].find(t => t.name === name)
  if (!found) throw new Error(`Missing tool: ${name}`)
  return found
}
function run(name: string, input: unknown, overrides: Partial<ToolContext> = {}) {
  const t = tool(name)
  return t.execute(t.parse(input), { ...ctx, ...overrides })
}

describe('save_artifact', () => {
  it('saves through the run-scoped artifact store without requiring or writing into folder grants', async () => {
    const result = await run('save_artifact', { name: 'report.md', content: '# Report\nhello 😀' }, { grants: [] })
    expect(result.ok).toBe(true)
    expect(result.artifactId).toBeTruthy()
    const saved = await ctx.artifacts.read(ctx.runId, result.artifactId!)
    expect(saved?.meta.name).toBe('report.md')
    expect(saved?.meta.mediaType).toBe('text/markdown')
    expect(Buffer.from(saved!.content).toString()).toBe('# Report\nhello 😀')
    expect(await readdir(root)).toEqual([])
  })

  it('validates artifact byte limits, names, media types and unknown fields strictly', () => {
    for (const input of [{ name: '', content: '' }, { name: ' '.repeat(3), content: '' }, { name: 'x'.repeat(201), content: '' }, { name: 'x', content: 1 }, { name: 'x', content: '😀'.repeat(262_145) }, { name: 'x', content: '', mediaType: 'text/html' }, { name: 'x', content: '', path: 'project/out' }]) {
      expect(() => tool('save_artifact').parse(input)).toThrow('Invalid tool input.')
    }
  })

  it('accepts each allowed text media type and preserves empty artifact content', async () => {
    for (const mediaType of ['text/markdown', 'text/plain', 'application/json', 'text/csv']) {
      const result = await run('save_artifact', { name: 'empty', content: '', mediaType })
      const saved = await ctx.artifacts.read(ctx.runId, result.artifactId!)
      expect(saved?.meta.mediaType).toBe(mediaType)
      expect(saved?.content.byteLength).toBe(0)
    }
  })

  it('rechecks cancellation immediately before saving rather than relying on the entry checkpoint', async () => {
    let checks = 0
    const result = await run('save_artifact', { name: 'report', content: 'do not persist' }, { checkpoint() {
      if (++checks === 2) throw new Error('generation revoked')
    } })
    expect(result.ok).toBe(false)
    expect(result.content).toBe('Tool execution cancelled.')
    expect((ctx.artifacts as TestArtifacts).entries.size).toBe(0)
    expect(await readdir(root)).toEqual([])
  })

  it('does not disclose raw artifact-store errors or absolute storage paths', async () => {
    class FailingArtifacts extends TestArtifacts {
      override async save(): Promise<ArtifactMeta> { throw new Error(`${dir}/private-token`) }
    }
    const result = await run('save_artifact', { name: 'report', content: 'text' }, { artifacts: new FailingArtifacts() })
    expect(result.ok).toBe(false)
    expect(result.content).toBe('Tool execution failed.')
  })
})

describe('tool contracts', () => {
  it('exports only read-scoped local tools and an approval-free any-scope artifact writer', () => {
    const local = localTools()
    expect(local.map(t => t.name)).toEqual(['list_files', 'read_file', 'search_files'])
    expect(artifactTools().map(t => t.name)).toEqual(['save_artifact'])
    for (const t of [...local, ...artifactTools()]) {
      expect(t.inputSchema.additionalProperties).toBe(false)
      expect(t.needsApproval({}, { grants: [] })).toBe(false)
      expect(t.effect).toBe(t.name === 'save_artifact' ? 'artifact-write' : 'read')
      expect(t.scope).toBe(t.name === 'save_artifact' ? 'any' : 'local')
    }
  })

  it('renders compact plain-text previews only from validated inputs', () => {
    const inputs = { list_files: {}, read_file: { path: 'notes\n.txt' }, search_files: { query: 'needle', path: 'project' }, save_artifact: { name: 'report', content: 'secret contents' } }
    for (const [name, input] of Object.entries(inputs)) {
      const preview = tool(name).preview(tool(name).parse(input))
      expect(preview.length).toBeGreaterThan(5)
      expect(preview.length).toBeLessThan(300)
      expect(preview).not.toMatch(/[\x00-\x1f]/)
      expect(preview).not.toContain('secret contents')
      expect(() => tool(name).preview({ unknown: true })).toThrow('Invalid tool input.')
    }
  })
})

describe('search_files', () => {
  it('stops after twenty thousand visited entries even when a deep tree contains only denied files', async () => {
    const leaf = join(root, ...Array.from({ length: 40 }, () => 'deep'))
    await mkdir(leaf, { recursive: true })
    for (let base = 0; base < 20_010; base += 200) {
      await Promise.all(Array.from({ length: Math.min(200, 20_010 - base) }, (_, i) => writeFile(join(leaf, `.env-${base + i}`), '')))
    }
    // Isolate the entry-count budget from the independent wall-clock budget.
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const result = await run('search_files', { query: 'needle' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('[Truncated]')
  }, 30_000)

  it('stops when the two-second wall budget expires during filesystem work', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(root, `${i}.txt`), 'no match')))
    let now = 0
    let checks = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const result = await run('search_files', { query: 'needle' }, { checkpoint() {
      if (++checks === 35) now = 2001
    } })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('[Truncated]')
  })

  it('searches literal text recursively and returns label-relative line numbers with bounded snippets', async () => {
    await mkdir(join(root, 'docs', 'nested'), { recursive: true })
    await writeFile(join(root, 'docs', 'nested', 'notes.md'), `intro\n${'x'.repeat(8190)}a.b${'y'.repeat(400)}\nend`)
    await writeFile(join(root, 'other.txt'), 'a.b')
    await writeFile(join(root, 'nomatch.md'), 'axb')
    const result = await run('search_files', { query: 'a.b', glob: '*.md' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('project/docs/nested/notes.md:2:')
    expect(result.content).toContain('a.b')
    expect(result.content).not.toContain('other.txt')
    expect(result.content).not.toContain('nomatch.md')
    expect(result.content).not.toContain(root)
    const snippet = result.content.trim().split(':').slice(2).join(':')
    expect(snippet.length).toBeLessThanOrEqual(200)
  })

  it('skips binary, oversized, credential, dependency, git and symlink targets during discovery', async () => {
    for (const directory of ['node_modules', '.git', '.ssh', 'nested']) await mkdir(join(root, directory))
    for (const path of ['node_modules/package.txt', '.git/objects', '.ssh/config', '.env', 'nested/visible.txt']) await writeFile(join(root, path), 'needle')
    await writeFile(join(root, 'binary.txt'), 'needle\0')
    await writeFile(join(root, 'large.txt'), 'needle')
    await truncate(join(root, 'large.txt'), 2 * 1024 * 1024 + 1)
    await writeFile(join(dir, 'private.txt'), 'needle')
    await symlink(join(dir, 'private.txt'), join(root, 'escape.txt'))
    await symlink('nested', join(root, 'alias'))
    const result = await run('search_files', { query: 'needle' })
    expect(result.ok).toBe(true)
    expect(result.content.trim()).toBe('project/nested/visible.txt:1:needle')
  })

  it('limits matches and bytes without buffering the rest of the tree', async () => {
    await writeFile(join(root, 'many.txt'), Array.from({ length: 210 }, () => 'needle😀'.repeat(40)).join('\n'))
    const limited = await run('search_files', { query: 'needle', limit: 2 })
    expect(limited.content.split('\n').filter(line => line.startsWith('project/'))).toHaveLength(2)
    expect(limited.content).toContain('[Truncated]')
    const budgeted = await run('search_files', { query: 'needle' }, { outputBudget: 83 })
    expect(Buffer.byteLength(budgeted.content)).toBeLessThanOrEqual(83)
    expect(budgeted.content).toContain('[Truncated]')
  })

  it('rejects regex-like globs, empty queries and malformed search limits', () => {
    for (const input of [{}, { query: '' }, { query: 'x'.repeat(201) }, { query: 1 }, { query: 'x', glob: '**/*.txt' }, { query: 'x', glob: '*' }, { query: 'x', glob: '*.tar.gz' }, { query: 'x', path: null }, { query: 'x', limit: 201 }, { query: 'x', limit: -1 }, { query: 'x', extra: true }]) {
      expect(() => tool('search_files').parse(input)).toThrow('Invalid tool input.')
    }
  })

  it('stops between files when cancellation arrives during traversal', async () => {
    await writeFile(join(root, 'a.txt'), 'needle')
    await writeFile(join(root, 'b.txt'), 'needle')
    const controller = new AbortController()
    let checks = 0
    const result = await run('search_files', { query: 'needle' }, { signal: controller.signal, checkpoint() {
      if (++checks === 35) controller.abort()
    } })
    expect(result.ok).toBe(false)
    expect(result.content).toBe('Tool execution cancelled.')
    expect(result.content).not.toContain('needle')
  })
})

describe('list_files', () => {
  it('lists bounded-depth entries with types and sizes while hiding denied names and symlink escapes', async () => {
    await mkdir(join(root, 'a', 'b', 'c', 'd'), { recursive: true })
    await writeFile(join(root, 'visible.txt'), 'four')
    await writeFile(join(root, '.env.production'), 'secret')
    await writeFile(join(dir, 'outside.txt'), 'private')
    await symlink(join(dir, 'outside.txt'), join(root, 'escape'))
    await symlink(root, join(root, 'a', 'cycle'))
    const shallow = await run('list_files', { depth: 0 })
    expect(shallow.ok).toBe(true)
    expect(shallow.content).toContain('project/visible.txt\tfile\t4 bytes')
    expect(shallow.content).toContain('project/a\tdirectory\t')
    expect(shallow.content).not.toContain('project/a/b')
    expect(shallow.content).not.toContain('.env')
    expect(shallow.content).not.toContain('escape')
    const deep = await run('list_files', { path: 'project', depth: 3 })
    expect(deep.ok).toBe(true)
    expect(deep.content).toContain('project/a/b/c/d\tdirectory')
    expect(deep.content).not.toContain(root)
    expect(deep.content.match(/cycle\//g) ?? []).toHaveLength(0)
  })

  it('enforces entry limits and UTF-8 output budgets including the fixed 32-KiB cap', async () => {
    await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(join(root, `${String(i).padStart(3, '0')}-${'é'.repeat(70)}.txt`), 'x')))
    const limited = await run('list_files', { limit: 2 })
    expect(limited.content.split('\n').filter(line => line.includes('\tfile\t'))).toHaveLength(2)
    expect(limited.content).toContain('[Truncated]')
    for (const outputBudget of [0, 1, 83, 200_000]) {
      const result = await run('list_files', { limit: 500 }, { outputBudget })
      expect(result.ok).toBe(true)
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(Math.min(outputBudget, 32 * 1024))
      if (outputBudget >= 83) expect(result.content).toContain('[Truncated]')
    }
  })

  it('rejects invalid list depths, unknown keys and non-integer limits', () => {
    for (const input of [[], { depth: -1 }, { depth: 4 }, { depth: '1' }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { path: false }, { extra: true }]) {
      expect(() => tool('list_files').parse(input)).toThrow('Invalid tool input.')
    }
  })

  it('denies file inputs and ungranted roots without returning absolute paths', async () => {
    await writeFile(join(root, 'file.txt'), 'x')
    for (const [path, grants] of [['file.txt', ctx.grants], [undefined, []], ['../outside', ctx.grants]] as const) {
      const result = await run('list_files', { path }, { grants })
      expect(result.ok).toBe(false)
      expect(result.content).toBe('Access denied by file policy.')
      expect(result.content).not.toContain(dir)
    }
  })
})

describe('read_file', () => {
  it('strictly validates read inputs rather than coercing malformed model values', () => {
    for (const input of [null, [], 'x', {}, { path: 4 }, { path: '' }, { path: 'x', extra: 1 }, { path: 'x', offset: 0 }, { path: 'x', offset: 1.5 }, { path: 'x', limit: 2001 }, { path: 'x', limit: '2' }]) {
      expect(() => tool('read_file').parse(input)).toThrow('Invalid tool input.')
    }
  })

  it('refuses binary files detected within the first eight KiB', async () => {
    await writeFile(join(root, 'binary.dat'), Buffer.concat([Buffer.from('text'), Buffer.alloc(8100), Buffer.from('secret')]))
    const result = await run('read_file', { path: 'binary.dat' })
    expect(result.ok).toBe(false)
    expect(result.content).toBe('Binary files are not supported.')
  })

  it('refuses files above five MiB including a sparse one-GiB file without reading their contents', async () => {
    await writeFile(join(root, 'large.txt'), 'large')
    await truncate(join(root, 'large.txt'), 5 * 1024 * 1024 + 1)
    await writeFile(join(root, 'sparse.txt'), 'sparse')
    await truncate(join(root, 'sparse.txt'), 1024 * 1024 * 1024)
    for (const path of ['large.txt', 'sparse.txt']) {
      const result = await run('read_file', { path })
      expect(result.ok).toBe(false)
      expect(result.content).toBe('File exceeds the size limit.')
    }
  })

  it('caps long UTF-8 lines at both the output budget and the fixed 64-KiB ceiling', async () => {
    await writeFile(join(root, 'long.txt'), '😀'.repeat(50_000))
    for (const outputBudget of [0, 1, 7, 83, 200_000]) {
      const result = await run('read_file', { path: 'long.txt' }, { outputBudget })
      expect(result.ok).toBe(true)
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(Math.min(outputBudget, 64 * 1024))
      if (outputBudget >= 83) expect(result.content).toContain('[Truncated]')
    }
  })

  it('honors a pre-aborted signal before accessing even a missing path', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run('read_file', { path: 'missing.txt' }, { signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.content).toBe('Tool execution cancelled.')
  })

  it('returns cancellation rather than ENOENT when the initial checkpoint deletes the file and throws', async () => {
    await writeFile(join(root, 'cancel.txt'), 'safe')
    const result = await run('read_file', { path: 'cancel.txt' }, { checkpoint() {
      unlinkSync(join(root, 'cancel.txt'))
      throw new Error('private cancellation detail')
    } })
    expect(result.ok).toBe(false)
    expect(result.content).toBe('Tool execution cancelled.')
    expect(result.content).not.toContain('ENOENT')
  })

  it('returns only the requested numbered lines using label-relative provenance', async () => {
    await writeFile(join(root, 'notes.txt'), 'alpha\r\nbeta\ngamma\ndelta')
    const result = await run('read_file', { path: 'notes.txt', offset: 2, limit: 2 })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('project/notes.txt')
    expect(result.content).toContain('2: beta\n3: gamma')
    expect(result.content).not.toContain('alpha')
    expect(result.content).not.toContain('delta')
    expect(result.content).not.toContain(root)
  })
})
