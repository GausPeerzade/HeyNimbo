import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

// electron-builder packs only the app's declared production dependency tree.
// pnpm resolves peer dependencies during development even when the app never
// declares them, so a missing peer only fails in the packaged app at launch
// (e.g. "Cannot find package 'zod'" from @ai-sdk/provider-utils).
interface Manifest { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
const appDir = join(__dirname, '../..')
const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
function packageDir(name: string, from: string): string {
  const require = createRequire(join(from, 'package.json'))
  let dir = dirname(require.resolve(name, { paths: [from] }))
  // Entry files live in subfolders such as dist/ that have no manifest of their own.
  while (!existsSync(join(dir, 'package.json')) || read(dir).name !== name) {
    if (dirname(dir) === dir) throw new Error(`No manifest for ${name}`)
    dir = dirname(dir)
  }
  return dir
}

it('packages every required peer dependency of the production dependency tree', () => {
  const declared = new Set(Object.keys(read(appDir).dependencies ?? {}))
  const seen = new Set<string>(), missing: string[] = []
  const queue = [...declared].map(name => ({ name, from: appDir }))
  while (queue.length) {
    const { name, from } = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    let dir: string
    try { dir = packageDir(name, from) } catch { continue } // workspace-native or platform-optional packages
    const manifest = read(dir)
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: dir })
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional) continue
      if (!declared.has(peer) && !Object.keys(manifest.dependencies ?? {}).includes(peer)) missing.push(`${name} → ${peer}`)
    }
  }
  // Guard against the walk silently skipping everything (which would pass vacuously).
  expect(seen.size).toBeGreaterThan(declared.size)
  // A peer satisfied by some other package's dependency is still not hoisted for
  // this importer in the packed app, so require the app to declare it directly.
  expect([...new Set(missing)].sort()).toEqual([])
})
