import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformWithOxc } from 'vite'
import { expect, it } from 'vitest'

it('keeps the complete emitted host and sdkModel import closure Electron-free while erasing Explain-only type imports', async () => {
  const root = dirname(fileURLToPath(import.meta.url))
  const visited = new Set<string>(), externals = new Set<string>()
  const walk = async (file: string): Promise<void> => {
    if (visited.has(file)) return
    visited.add(file)
    const { code } = await transformWithOxc(readFileSync(file, 'utf8'), file)
    for (const match of code.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\(\s*)['"]([^'"]+)/g)) {
      const target = match[1]!
      if (target.startsWith('.')) await walk(resolve(dirname(file), `${target}.ts`))
      else externals.add(target)
    }
  }
  await walk(resolve(root, 'entry.ts'))
  expect([...externals].filter(id => id === 'electron' || id.startsWith('electron/'))).toEqual([])
  expect(visited).toContain(resolve(root, '../../main/answer-provider.ts'))
  expect(visited).toContain(resolve(root, '../../main/provider-settings.ts'))
  expect([...visited].filter(file => file.includes('/voice/'))).toEqual([])
})
