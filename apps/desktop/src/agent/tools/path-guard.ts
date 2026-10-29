import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, win32 } from 'node:path'
import type { FolderGrant } from '../../shared/agent-protocol'

export const POLICY_DENIED = 'Access denied by file policy.'
export class PathDenied extends Error {
  constructor() { super(POLICY_DENIED) }
}
class HardLinkDenied extends PathDenied {
  constructor() { super(); this.message = 'This file has multiple hard links and cannot be read safely.' }
}
export interface GuardedPath { absolute: string; root: string; modelPath: string }
export interface OpenedPath { path: GuardedPath; handle: FileHandle; stat: Stats }
type Checkpoint = () => void
const noop = (): void => {}

// realpath canonicalizes APFS spelling/case. Never lowercase paths: APFS can
// also be case-sensitive. relative checks component boundaries, not prefixes.
function contained(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
}

export function deniedName(path: string): boolean {
  const parts = path.toLowerCase().split('/')
  return parts.some((part, i) => part.startsWith('.env') || /\.(pem|key)$/.test(part)
    || part.startsWith('id_rsa') || ['.ssh', '.aws', '.npmrc', '.netrc', 'keychains'].includes(part)
    || part.includes('.keychain') || (part === 'config' && parts[i - 1] === '.git'))
}

// Keep cancellation outside the filesystem-error sanitizer.
async function io<T>(checkpoint: Checkpoint, action: () => Promise<T>): Promise<T> {
  checkpoint()
  try { return await action() } catch { throw new PathDenied() }
}

export async function resolvePath(modelPath: string | undefined, grants: readonly FolderGrant[], checkpoint: Checkpoint = noop): Promise<GuardedPath> {
  const input = modelPath ?? ''
  if (input.length > 4096 || /[\0\\]/.test(input) || isAbsolute(input) || win32.isAbsolute(input)) throw new PathDenied()
  const parts = input.split('/').filter(part => part && part !== '.')
  if (parts.includes('..')) throw new PathDenied()
  const matches = grants.filter(grant => grant.label === parts[0])
  const grant = matches.length === 1 ? matches[0] : grants.length === 1 && !matches.length ? grants[0] : undefined
  if (!grant || !grant.label || /[/\\\x00-\x1f]/.test(grant.label) || ['.', '..'].includes(grant.label)) throw new PathDenied()
  if (matches.length) parts.shift()
  if (deniedName(parts.join('/')) || deniedName(grant.root)) throw new PathDenied()
  const root = await io(checkpoint, () => realpath(grant.root))
  // The picked canonical path is authority, not a fresh symlink target. Legacy
  // grants lack identity but still must not follow a replaced root/ancestor.
  if (root !== grant.root) throw new PathDenied()
  if (grant.identity !== undefined) {
    const stat = await io(checkpoint, () => lstat(root, { bigint: true }))
    if (!stat.isDirectory() || `${stat.dev}:${stat.ino}` !== grant.identity) throw new PathDenied()
  }
  let absolute = root
  for (const part of parts) {
    const candidate = join(absolute, part)
    absolute = await io(checkpoint, () => realpath(candidate))
    // Check each intermediate target, not just a final target that could have
    // escaped through one symlink and re-entered the grant through another.
    if (!contained(root, absolute) || deniedName(absolute)) throw new PathDenied()
  }
  return { absolute, root, modelPath: [grant.label, ...parts].join('/') }
}

function sameFile(a: Stats, b: Stats): boolean { return a.ino === b.ino && a.dev === b.dev }

export async function openPath(modelPath: string | undefined, grants: readonly FolderGrant[], kind: 'file' | 'directory' = 'file', checkpoint: Checkpoint = noop): Promise<OpenedPath> {
  const path = await resolvePath(modelPath, grants, checkpoint)
  const before = await io(checkpoint, () => lstat(path.absolute))
  const validKind = (stat: Stats): boolean => kind === 'file' ? stat.isFile() : stat.isDirectory()
  if (!validKind(before)) throw new PathDenied()
  const handle = await io(checkpoint, () => open(path.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const stat = await io(checkpoint, () => handle.stat())
    if (!validKind(stat) || !sameFile(before, stat)) throw new PathDenied()
    // A safe name cannot prove provenance: hard links can alias denied names
    // inside or outside this grant. Reject all multi-link files, including
    // legitimate ones, rather than pretending a name denylist covers aliases.
    if (kind === 'file' && stat.nlink > 1) throw new HardLinkDenied()
    // Linux exposes the actual opened handle. Node has no F_GETPATH on macOS:
    // open the canonical path, compare dev/ino with lstat, then recheck its path.
    const current = await io(checkpoint, () => realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path.absolute))
    if (!contained(path.root, current) || deniedName(current)) throw new PathDenied()
    const after = await io(checkpoint, () => lstat(current))
    if (!sameFile(after, stat)) throw new PathDenied()
    return { path, handle, stat }
  } catch (error) {
    await handle.close()
    throw error
  }
}

// Residual risk: Node lacks openat/O_BENEATH and macOS F_GETPATH. Concurrent
// hostile renames/hard links or in-place writes cannot be sandboxed completely
// by pathname checks. Reads use the verified handle; directories are re-resolved
// per entry. This is a read-only grant boundary, not an OS filesystem sandbox.
