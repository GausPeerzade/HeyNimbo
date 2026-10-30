import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** What the owner is asked before something runs; the text is built here, never by the model. */
export interface Approval { tool: string; title: string; detail: string }
export type Verdict = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; approval: Approval }
export const PRIVATE = 'HeyNimbo does not open secret or private app files.'
const MAX_LINKS = 40

/** Secret stores are never read or written by the file tools, even in a folder the agent may use. */
export function secretPath(path: string): boolean {
  const parts = path.toLowerCase().split('/')
  return parts.some((part, i) => part.startsWith('.env') || /\.(pem|key|p12)$/.test(part)
    || part.startsWith('id_rsa') || part.startsWith('id_ed25519') || ['.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', 'keychains'].includes(part)
    // Plaintext key stores: HeyNimbo's credentials.json and Pi/OpenCode/Codex/Claude Code auth files.
    || /^\.?(credentials|auth)\.json/.test(part)
    || part.includes('.keychain') || (part === 'config' && parts[i - 1] === '.git'))
}

/** Where an absolute path really leads. Symlinks are followed, dangling ones too, since a write creates their
 *  target; a path that cannot be resolved safely throws instead of passing unresolved. */
export function real(path: string, links = { count: 0 }): string {
  try { return realpathSync(path) } catch { /* Missing, or a dangling link. */ }
  let link: string | undefined
  try { if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path) } catch { /* Does not exist yet. */ }
  if (link !== undefined) {
    if (++links.count > MAX_LINKS) throw new Error(PRIVATE)
    return real(resolve(dirname(path), link), links)
  }
  const parent = dirname(path)
  return parent === path ? path : join(real(parent, links), relative(parent, path))
}
export const inside = (root: string, path: string): boolean => { const rest = relative(root, path); return !rest.startsWith('..') && !isAbsolute(rest) }
export const show = (path: string): string => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

/** A secret store or HeyNimbo's own data. Installed skills in the data folder stay readable. */
export function privatePath(path: string, dataDir: string, write = false): boolean {
  let target: string
  try { target = real(path) } catch { return true }
  const data = real(dataDir)
  if (secretPath(target) || secretPath(path)) return true
  return inside(data, target) && (write || !inside(join(data, 'agent', 'skills'), target))
}

/** Decided before a tool runs. File tools are checked again on the exact path they open (files.ts);
 *  this early check only spares the model a call that would be refused anyway. */
export function judge(tool: string, input: Record<string, unknown>, workspace: string, dataDir: string): Verdict {
  if (tool === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return { kind: 'ask', approval: { tool, title: 'Run this command on your Mac?', detail: `${command.slice(0, 2000)}\n\nCommands run with your full access, including files HeyNimbo's own tools never open.` } }
  }
  if (['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(tool)) {
    const path = typeof input.path === 'string' ? resolve(workspace, input.path.replace(/^~(?=\/|$)/, homedir())) : undefined
    return path && privatePath(path, dataDir, tool === 'write' || tool === 'edit') ? { kind: 'deny', reason: PRIVATE } : { kind: 'allow' }
  }
  if (tool === 'web_search' || tool === 'web_fetch') return { kind: 'allow' }
  return { kind: 'ask', approval: { tool, title: `Allow HeyNimbo to use ${tool}?`, detail: JSON.stringify(input).slice(0, 2000) } }
}
