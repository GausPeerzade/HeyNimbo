import { StringDecoder } from 'node:string_decoder'
import { opendir, type FileHandle } from 'node:fs/promises'
import type { AgentTool, ToolContext, ToolOutcome } from '../contracts'
import { deniedName, openPath, PathDenied, POLICY_DENIED } from './path-guard'

const KiB = 1024
const MiB = 1024 * KiB
const INVALID = 'Invalid tool input.'
class SafeError extends Error {}
class Cancelled extends SafeError { constructor() { super('Tool execution cancelled.') } }
function check(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw new Cancelled()
  try { ctx.checkpoint() } catch { throw new Cancelled() }
  if (ctx.signal.aborted) throw new Cancelled()
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(INVALID)
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error(INVALID)
  return input as Record<string, unknown>
}
function text(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.length || input.length > max) throw new Error(INVALID)
  return input
}
function int(input: unknown, min: number, max: number, fallback: number): number {
  if (input === undefined) return fallback
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(INVALID)
  return input
}
function plain(text: string): string { return text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) }
function prefix(text: string, bytes: number): string {
  // Streaming decode discards a partial trailing UTF-8 sequence instead of
  // inserting a replacement character that could itself exceed the byte cap.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, Math.max(0, bytes)), { stream: true })
}
class Output {
  private value = ''
  private bytes = 0
  truncated = false
  readonly cap: number
  constructor(budget: number, cap: number) { this.cap = Math.max(0, Math.min(cap, Number.isFinite(budget) ? Math.floor(budget) : 0)) }
  get full(): boolean { return this.bytes >= this.cap }
  add(text: string): boolean {
    const remaining = this.cap - this.bytes
    const size = Buffer.byteLength(text)
    this.value += size > remaining ? prefix(text, remaining) : text
    this.bytes = Math.min(this.cap, this.bytes + size)
    if (size > remaining) this.truncated = true
    return !this.truncated
  }
  finish(): string {
    const note = '\n[Truncated]'
    return this.truncated ? prefix(this.value, this.cap - Buffer.byteLength(note)) + prefix(note, this.cap) : this.value
  }
}
function define<I>(options: {
  name: string; description: string; properties: Record<string, unknown>; required?: string[]
  effect: AgentTool['effect']; scope: AgentTool['scope']; parse(input: unknown): I
  preview(input: I): string; run(input: I, ctx: ToolContext): Promise<ToolOutcome>
}): AgentTool {
  return {
    name: options.name, description: options.description, effect: options.effect, scope: options.scope,
    inputSchema: { type: 'object', additionalProperties: false, properties: options.properties, required: options.required ?? [] },
    needsApproval: () => false, parse: options.parse, preview: input => options.preview(options.parse(input)),
    async execute(input, ctx) {
      try {
        check(ctx)
        return await options.run(options.parse(input), ctx)
      } catch (error) {
        const message = error instanceof PathDenied ? POLICY_DENIED : error instanceof SafeError ? error.message : 'Tool execution failed.'
        return { ok: false, content: prefix(message, Math.max(0, Math.min(64 * KiB, ctx.outputBudget))), summary: error instanceof Cancelled ? 'Tool execution cancelled.' : 'Tool execution failed.' }
      }
    },
  }
}

async function binary(handle: FileHandle, check: () => void): Promise<boolean> {
  const sample = Buffer.alloc(8 * KiB)
  check()
  const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
  return sample.subarray(0, bytesRead).includes(0)
}

// A bounded line accumulator also handles huge single lines. Reads never pass
// the initial fstat size, even if another process grows the file during a read.
async function* lines(handle: FileHandle, bytes: number, lineCap: number, checkpoint: () => void) {
  const buffer = Buffer.alloc(8 * KiB)
  const decoder = new StringDecoder('utf8')
  let position = 0
  let pending = ''
  let clipped = false
  let number = 1
  while (position < bytes) {
    checkpoint()
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - position), position)
    if (!bytesRead) break
    position += bytesRead
    const chunks = decoder.write(buffer.subarray(0, bytesRead)).split('\n')
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const room = lineCap - pending.length
      if (chunk.length > room) clipped = true
      pending += chunk.slice(0, room)
      if (i < chunks.length - 1) {
        yield { number: number++, text: pending.replace(/\r$/, ''), clipped }
        pending = ''
        clipped = false
      }
    }
  }
  const tail = decoder.end()
  if (pending.length + tail.length > lineCap) clipped = true
  pending += tail.slice(0, Math.max(0, lineCap - pending.length))
  if (pending || clipped) yield { number, text: pending.replace(/\r$/, ''), clipped }
}

type ReadInput = { path: string; offset: number; limit: number }
function parseRead(input: unknown): ReadInput {
  const value = object(input, ['path', 'offset', 'limit'])
  return { path: text(value.path, 4096), offset: int(value.offset, 1, Number.MAX_SAFE_INTEGER, 1), limit: int(value.limit, 1, 2000, 2000) }
}
async function read(input: ReadInput, ctx: ToolContext): Promise<ToolOutcome> {
  const checkpoint = (): void => check(ctx)
  const opened = await openPath(input.path, ctx.grants, 'file', checkpoint)
  try {
    if (opened.stat.size > 5 * MiB) throw new SafeError('File exceeds the size limit.')
    if (await binary(opened.handle, checkpoint)) throw new SafeError('Binary files are not supported.')
    const output = new Output(ctx.outputBudget, 64 * KiB)
    output.add(`${opened.path.modelPath}\n`)
    let count = 0
    for await (const line of lines(opened.handle, opened.stat.size, 64 * KiB, checkpoint)) {
      if (line.number < input.offset) continue
      output.add(`${line.number}: ${line.text}\n`)
      if (line.clipped) output.truncated = true
      if (output.full || output.truncated || ++count >= input.limit) break
    }
    checkpoint()
    return { ok: true, content: output.finish(), summary: 'Read local file.' }
  } finally { await opened.handle.close() }
}
type WalkEntry = { path: string; type: 'file' | 'directory'; size: number }
class WalkLimit extends Error {}
class WalkBudget {
  private visited = 0
  private readonly deadline = performance.now() + 2000
  constructor(private readonly ctx: ToolContext) {}
  checkpoint = (): void => {
    check(this.ctx)
    if (performance.now() >= this.deadline) throw new WalkLimit()
  }
  visit(): void { if (++this.visited > 20_000) throw new WalkLimit() }
}
async function* walk(path: string | undefined, ctx: ToolContext, depth: number, budget: WalkBudget, skipDependencies = false) {
  const queue = [{ path, depth: 0 }]
  const visited = new Set<string>()
  const checkpoint = budget.checkpoint
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!
    let opened
    try { opened = await openPath(current.path, ctx.grants, 'directory', checkpoint) } catch (error) {
      if (index > 0 && error instanceof PathDenied) continue
      throw error
    }
    try {
      if (visited.has(opened.path.absolute)) continue
      visited.add(opened.path.absolute)
      checkpoint()
      const directory = await opendir(opened.path.absolute)
      for await (const entry of directory) {
        checkpoint()
        // Count before filtering: a credential-only or directory-only tree must
        // not bypass the scan budget. The queue is bounded by this same cap.
        budget.visit()
        // Discovery never follows symlinks. Explicit reads may follow a symlink
        // only after path-guard validates its canonical target and handle.
        if (deniedName(entry.name) || (!entry.isFile() && !entry.isDirectory())
          || (skipDependencies && ['node_modules', '.git'].includes(entry.name.toLowerCase()))) continue
        const child = `${opened.path.modelPath}/${entry.name}`
        const type = entry.isDirectory() ? 'directory' : 'file'
        let item
        try { item = await openPath(child, ctx.grants, type, checkpoint) } catch (error) {
          if (error instanceof PathDenied) continue
          throw error
        }
        const result: WalkEntry = { path: item.path.modelPath, type, size: item.stat.size }
        await item.handle.close()
        if (type === 'directory' && current.depth < depth) queue.push({ path: child, depth: current.depth + 1 })
        yield result
      }
    } finally { await opened.handle.close() }
  }
}
type ListInput = { path?: string; depth: number; limit: number }
function parseList(input: unknown): ListInput {
  const value = object(input, ['path', 'depth', 'limit'])
  return { ...(value.path !== undefined ? { path: text(value.path, 4096) } : {}), depth: int(value.depth, 0, 3, 0), limit: int(value.limit, 1, 500, 200) }
}
async function list(input: ListInput, ctx: ToolContext): Promise<ToolOutcome> {
  const output = new Output(ctx.outputBudget, 32 * KiB)
  let count = 0
  try {
    for await (const entry of walk(input.path, ctx, input.depth, new WalkBudget(ctx))) {
      if (count++ >= input.limit) { output.truncated = true; break }
      if (!output.add(`${entry.path}\t${entry.type}\t${entry.size} bytes\n`)) break
    }
  } catch (error) {
    if (!(error instanceof WalkLimit)) throw error
    output.truncated = true
  }
  check(ctx)
  return { ok: true, content: output.finish(), summary: 'Listed local files.' }
}

type SearchInput = { query: string; path?: string; glob?: string; limit: number }
function parseSearch(input: unknown): SearchInput {
  const value = object(input, ['query', 'path', 'glob', 'limit'])
  if (value.glob !== undefined && (typeof value.glob !== 'string' || !/^\*\.[A-Za-z0-9_-]+$/.test(value.glob))) throw new Error(INVALID)
  return { query: text(value.query, 200), ...(value.path !== undefined ? { path: text(value.path, 4096) } : {}), ...(value.glob !== undefined ? { glob: value.glob as string } : {}), limit: int(value.limit, 1, 200, 100) }
}
async function search(input: SearchInput, ctx: ToolContext): Promise<ToolOutcome> {
  const output = new Output(ctx.outputBudget, 64 * KiB)
  const budget = new WalkBudget(ctx)
  const checkpoint = budget.checkpoint
  let count = 0
  try {
    outer: for await (const entry of walk(input.path, ctx, Infinity, budget, true)) {
      checkpoint()
      if (entry.type !== 'file' || entry.size > 2 * MiB || (input.glob && !entry.path.endsWith(input.glob.slice(1)))) continue
      let opened
      try { opened = await openPath(entry.path, ctx.grants, 'file', checkpoint) } catch (error) {
        if (error instanceof PathDenied) continue
        throw error
      }
      try {
        if (opened.stat.size > 2 * MiB || await binary(opened.handle, checkpoint)) continue
        for await (const line of lines(opened.handle, opened.stat.size, 2 * MiB, checkpoint)) {
          checkpoint()
          const match = line.text.indexOf(input.query)
          if (match < 0) continue
          if (count++ >= input.limit) { output.truncated = true; break outer }
          const start = Math.max(0, match - Math.min(60, 200 - input.query.length))
          if (!output.add(`${entry.path}:${line.number}:${line.text.slice(start, start + 200)}\n`)) break outer
        }
      } finally { await opened.handle.close() }
    }
  } catch (error) {
    if (!(error instanceof WalkLimit)) throw error
    output.truncated = true
  }
  check(ctx)
  return { ok: true, content: output.finish(), summary: 'Searched local files.' }
}

export function localTools(): AgentTool[] {
  return [
    define({
      name: 'list_files',
      description: 'List files and sizes within a granted folder. Discovery skips symlinks and credential files.',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        depth: { type: 'integer', minimum: 0, maximum: 3 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      effect: 'read', scope: 'local', parse: parseList, run: list,
      preview: input => `List ${plain(input.path ?? 'the granted folder')} (depth ${input.depth}, up to ${input.limit} entries).`,
    }),
    define({
      name: 'read_file',
      description: 'Read numbered lines from a granted folder. Paths use grant labels, never absolute roots.',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      required: ['path'], effect: 'read', scope: 'local', parse: parseRead, run: read,
      preview: input => `Read ${plain(input.path)} from line ${input.offset} (up to ${input.limit} lines).`,
    }),
    define({
      name: 'search_files',
      description: 'Search literal text recursively within a granted folder. Skips dependencies, git, symlinks, credentials, binary and oversized files.',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        glob: { type: 'string', pattern: '^\\*\\.[A-Za-z0-9_-]+$' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['query'], effect: 'read', scope: 'local', parse: parseSearch, run: search,
      preview: input => `Search ${plain(input.path ?? 'the granted folder')} for “${plain(input.query)}” (up to ${input.limit} matches).`,
    }),
  ]
}
const MEDIA_TYPES = ['text/markdown', 'text/plain', 'application/json', 'text/csv'] as const
type ArtifactInput = { name: string; content: string; mediaType: string }
function parseArtifact(input: unknown): ArtifactInput {
  const value = object(input, ['name', 'content', 'mediaType'])
  const name = text(value.name, 200)
  if (!name.trim() || typeof value.content !== 'string' || Buffer.byteLength(value.content) > MiB
    || (value.mediaType !== undefined && (typeof value.mediaType !== 'string' || !MEDIA_TYPES.includes(value.mediaType as typeof MEDIA_TYPES[number])))) throw new Error(INVALID)
  return { name, content: value.content, mediaType: (value.mediaType as string | undefined) ?? 'text/markdown' }
}
async function save(input: ArtifactInput, ctx: ToolContext): Promise<ToolOutcome> {
  const content = Buffer.from(input.content)
  check(ctx)
  const meta = await ctx.artifacts.save(ctx.runId, input.name, input.mediaType, content)
  const output = new Output(ctx.outputBudget, 64 * KiB)
  output.add(`Saved artifact ${meta.id}.`)
  return { ok: true, content: output.finish(), summary: 'Saved artifact.', artifactId: meta.id }
}
export function artifactTools(): AgentTool[] {
  return [define({
    name: 'save_artifact',
    description: 'Save a text artifact in app storage, never in granted folders.',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      content: { type: 'string', maxLength: MiB },
      mediaType: { type: 'string', enum: [...MEDIA_TYPES] },
    },
    required: ['name', 'content'], effect: 'artifact-write', scope: 'any', parse: parseArtifact, run: save,
    preview: input => `Save artifact “${plain(input.name)}” (${Buffer.byteLength(input.content)} bytes, ${input.mediaType}).`,
  })]
}
