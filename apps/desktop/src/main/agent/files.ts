import { constants } from 'node:fs'
import { access, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { inside, PRIVATE, privatePath, real, show } from './policy'

type Pi = typeof import('@earendil-works/pi-coding-agent')
export interface FileGuard {
  workspace: string
  dataDir: string
  /** Folders the owner allowed changes in during this turn. */
  approved: Set<string>
  /** Whether the owner allowed changes anywhere for this conversation. */
  everywhere(): boolean
  /** Asks the owner about a change outside the workspace; resolves false when declined or stopped. */
  approve(folder: string): Promise<boolean>
}

const SIGNATURES: Array<[number[], string]> = [[[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x47, 0x49, 0x46, 0x38], 'image/gif']]
async function imageType(path: string): Promise<string | null> {
  const file = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(12), 0, 12, 0)
    if (bytesRead >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
    return SIGNATURES.find(([magic]) => magic.every((byte, i) => buffer[i] === byte))?.[1] ?? null
  } finally { await file.close() }
}

/** Pi prints a match's text straight from ripgrep unless context lines are asked for; with at least one,
 *  every printed line is read through the guarded `readFile` on the file's true path. */
function grep<T extends ToolDefinition<any, any>>(definition: T): T {
  return { ...definition, execute: (id: string, params: { context?: number }, ...rest: unknown[]) => (definition.execute as (...args: unknown[]) => unknown)(id, { ...params, context: Math.max(1, Number(params.context) || 0) }, ...rest) } as T
}

/** Pi's file tools with every filesystem call checked on the exact path Pi finally opens, after all of
 *  its own path handling (`@`, `~`, `file://`, Unicode and screenshot-name variants, symlinks). */
export function fileTools(pi: Pi, guard: FileGuard): ToolDefinition[] {
  const readable = (path: string): string => {
    if (privatePath(path, guard.dataDir)) throw new Error(PRIVATE)
    return path
  }
  /** Approval is per folder that really changes: the directory for mkdir, else the resolved file's
   *  parent, so a symlink in the workspace cannot point a write somewhere else unasked. */
  const writable = async (path: string, kind: 'dir' | 'file'): Promise<void> => {
    if (privatePath(path, guard.dataDir, true)) throw new Error(PRIVATE)
    const target = kind === 'dir' ? real(path) : dirname(real(path))
    if (inside(real(guard.workspace), target) || guard.everywhere() || guard.approved.has(target)) return
    if (!await guard.approve(target)) throw new Error(`The owner declined changes in ${show(target)}. Do not retry it; say what you could not do.`)
    guard.approved.add(target)
  }
  const cwd = guard.workspace
  return [
    pi.createReadToolDefinition(cwd, { operations: {
      readFile: path => readFile(readable(path)),
      access: path => access(readable(path), constants.R_OK),
      detectImageMimeType: path => imageType(readable(path)),
    } }),
    pi.createWriteToolDefinition(cwd, { operations: {
      mkdir: async dir => { await writable(dir, 'dir'); await mkdir(dir, { recursive: true }) },
      writeFile: async (path, content) => { await writable(path, 'file'); await writeFile(path, content, 'utf8') },
    } }),
    pi.createEditToolDefinition(cwd, { operations: {
      readFile: path => readFile(readable(path)),
      access: path => access(readable(path), constants.R_OK | constants.W_OK),
      writeFile: async (path, content) => { await writable(path, 'file'); await writeFile(path, content, 'utf8') },
    } }),
    grep(pi.createGrepToolDefinition(cwd, { operations: {
      isDirectory: async path => (await stat(readable(path))).isDirectory(),
      // A private file contributes no lines: Pi then reports it as unreadable.
      readFile: path => privatePath(path, guard.dataDir) ? '' : readFile(path, 'utf8'),
    } })),
    // Listing shows names, not contents; only listing inside private folders is refused.
    pi.createLsToolDefinition(cwd, { operations: {
      exists: async path => { try { await stat(path); return true } catch { return false } },
      stat: path => stat(path),
      readdir: path => readdir(readable(path)),
    } }),
  ] as ToolDefinition[]
}
