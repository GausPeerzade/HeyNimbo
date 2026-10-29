import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderGrant } from '../../shared/agent-protocol'
import { resolvePath, openPath } from './path-guard'
import { renameSync, symlinkSync, unlinkSync } from 'node:fs'

let dir: string
let grant: FolderGrant
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heynimbo-path-'))
  const root = join(dir, 'project')
  await mkdir(root)
  await writeFile(join(root, 'notes.txt'), 'safe')
  grant = { id: 'g1', label: 'project', root }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('grant path resolution', () => {
  it('denies credential names and aliases even when a home-like directory was granted', async () => {
    const denied = ['.env', '.env.local', 'cert.pem', 'signing.KEY', 'id_rsa.pub', '.ssh/config', '.aws/credentials', '.git/config', '.npmrc', '.netrc', 'login.keychain-db', 'Library/Keychains/login']
    for (const path of denied) {
      await mkdir(join(grant.root, path, '..'), { recursive: true })
      await writeFile(join(grant.root, path), 'synthetic credential')
      await expect(resolvePath(path, [grant])).rejects.toThrow('Access denied by file policy.')
    }
    await symlink('.env', join(grant.root, 'innocent.txt'))
    await expect(resolvePath('innocent.txt', [grant])).rejects.toThrow('Access denied by file policy.')
    await expect(resolvePath('config', [{ ...grant, root: join(grant.root, '.ssh') }])).rejects.toThrow('Access denied by file policy.')
  })

  it('opens a verified regular-file handle and rejects a directory as file input', async () => {
    const opened = await openPath('notes.txt', [grant])
    try {
      expect(await opened.handle.readFile('utf8')).toBe('safe')
      expect(opened.stat.isFile()).toBe(true)
    } finally { await opened.handle.close() }
    await expect(openPath(undefined, [grant])).rejects.toThrow('Access denied by file policy.')
  })

  it('does not open a file when the last checkpoint revokes access', async () => {
    await expect(openPath('notes.txt', [grant], 'file', () => {
      throw new Error('cancelled generation')
    })).rejects.toThrow('cancelled generation')
  })

  it('rejects a final-target symlink swap between lstat and open', async () => {
    const outside = join(dir, 'outside.txt')
    await writeFile(outside, 'private')
    let checkpoints = 0
    await expect(openPath('notes.txt', [grant], 'file', () => {
      if (++checkpoints === 4) {
        unlinkSync(join(grant.root, 'notes.txt'))
        symlinkSync(outside, join(grant.root, 'notes.txt'))
      }
    })).rejects.toThrow('Access denied by file policy.')
  })

  it('rejects an intermediate directory replacement by comparing opened device and inode', async () => {
    await mkdir(join(grant.root, 'sub'))
    await mkdir(join(dir, 'outside'))
    await writeFile(join(grant.root, 'sub', 'same.txt'), 'safe')
    await writeFile(join(dir, 'outside', 'same.txt'), 'private')
    let checkpoints = 0
    await expect(openPath('sub/same.txt', [grant], 'file', () => {
      if (++checkpoints === 5) {
        renameSync(join(grant.root, 'sub'), join(grant.root, 'old-sub'))
        symlinkSync(join(dir, 'outside'), join(grant.root, 'sub'))
      }
    })).rejects.toThrow('Access denied by file policy.')
  })

  it('rejects traversal, absolute paths and NUL bytes with one safe policy error', async () => {
    await writeFile(join(dir, 'outside.txt'), 'private')
    for (const path of ['../outside.txt', 'project/../notes.txt', grant.root, '/etc/passwd', 'C:\\private', 'notes.txt\0', '..\\outside.txt']) {
      await expect(resolvePath(path, [grant])).rejects.toThrow('Access denied by file policy.')
    }
  })

  it('requires an unambiguous label for multiple grants and denies ungranted roots', async () => {
    const second = { ...grant, id: 'g2', label: 'other' }
    await expect(resolvePath('notes.txt', [grant, second])).rejects.toThrow('Access denied by file policy.')
    await expect(resolvePath(undefined, [])).rejects.toThrow('Access denied by file policy.')
    await expect(resolvePath('project/notes.txt', [grant, { ...second, label: 'project' }])).rejects.toThrow('Access denied by file policy.')
    expect((await resolvePath('other/notes.txt', [grant, second])).modelPath).toBe('other/notes.txt')
  })

  it('denies an intermediate symlink outside the root even when a later symlink returns inside', async () => {
    const outside = join(dir, 'outside')
    await mkdir(outside)
    await symlink(outside, join(grant.root, 'detour'))
    await symlink(grant.root, join(outside, 'return'))
    await expect(resolvePath('detour/return/notes.txt', [grant])).rejects.toThrow('Access denied by file policy.')
  })

  it('rejects final and intermediate symlink escapes including a prefix-collision sibling and symlink loops', async () => {
    const sibling = join(dir, 'project-extra')
    await mkdir(sibling)
    await writeFile(join(sibling, 'secret.txt'), 'private')
    await symlink(join(sibling, 'secret.txt'), join(grant.root, 'escape'))
    await symlink(sibling, join(grant.root, 'outside-dir'))
    await symlink('loop-b', join(grant.root, 'loop-a'))
    await symlink('loop-a', join(grant.root, 'loop-b'))
    for (const path of ['escape', 'outside-dir/secret.txt', 'loop-a']) {
      await expect(resolvePath(path, [grant])).rejects.toThrow('Access denied by file policy.')
    }
    await symlink('notes.txt', join(grant.root, 'inside'))
    expect((await resolvePath('inside', [grant])).modelPath).toBe('project/inside')
  })

  it('resolves label-relative and single-grant relative paths without exposing the root in model paths', async () => {
    const labeled = await resolvePath('project/notes.txt', [grant])
    const relative = await resolvePath('notes.txt', [grant])
    expect(labeled.absolute).toBe(await realpath(join(grant.root, 'notes.txt')))
    expect(labeled.modelPath).toBe('project/notes.txt')
    expect(relative).toEqual(labeled)
    expect((await resolvePath(undefined, [grant])).modelPath).toBe('project')
  })
})
