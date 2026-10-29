import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import type { ScreenCaptures } from '@heynimbo/native'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './app-shell'
import { AgentSupervisor } from './agent-supervisor'
import { ConversationController } from './conversations'
import { HistoryRepository } from './history'
import { DEFAULT_SETTINGS } from './settings'
import { pageURL } from './page-security'
import { TalkSession } from './voice/talk'
import { DEFAULT_BUDGET, type HostCommand, type MainToHost } from '../shared/agent-protocol'

const electron = vi.hoisted(() => ({ dir: '', fork: vi.fn(), handlers: new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>() }))
vi.mock('./audio-window', () => ({ ensureMicrophoneAccess: vi.fn(), microphoneAccessStatus: () => 'granted' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.dir, getVersion: () => 'test', isPackaged: false, on() {} },
  utilityProcess: { fork: electron.fork },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) => electron.handlers.set(channel, handler), removeHandler: (channel: string) => electron.handlers.delete(channel) },
  globalShortcut: { register: () => true, unregister() {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  Tray: class { setToolTip() {} setContextMenu() {} destroy() {} },
  nativeTheme: { shouldUseDarkColors: false }, dialog: {}, shell: {},
}))

const directories: string[] = []
function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-explain-gates-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); electron.fork.mockReset(); electron.handlers.clear()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Tokenize comments/quoted text before looking for module edges. A regex over
// raw source would mistake prompt text for imports and miss multiline exports.
function moduleSpecifiers(source: string): string[] {
  const tokens = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)]
    .map(match => match[0]).filter(token => !token.startsWith('//') && !token.startsWith('/*'))
  const quoted = (token = '') => token.startsWith('"') || token.startsWith("'")
  const edges: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1]
    if (token !== 'import' && token !== 'export' && token !== 'require') continue
    if (next === '.') continue // import.meta is not a dependency.
    if (quoted(next)) { edges.push(next!.slice(1, -1)); continue }
    if (next === '(') {
      if (!quoted(tokens[i + 2])) throw new Error('Nonliteral module edge; extend the isolation gate before using it.')
      edges.push(tokens[i + 2]!.slice(1, -1))
      continue
    }
    if (token === 'require' || (token === 'export' && !['*', '{'].includes(next === 'type' ? tokens[i + 2]! : next!))) continue
    for (let j = i + 1; j < tokens.length; j++) {
      if ([';', 'import', 'export'].includes(tokens[j]!)) break
      if (tokens[j] === 'from' && quoted(tokens[j + 1])) { edges.push(tokens[j + 1]!.slice(1, -1)); break }
    }
  }
  return edges
}
function assertExplainIsolation(root: string, entries: string[]): Set<string> {
  const visited = new Set<string>()
  function visit(file: string, trail: string[]): void {
    const name = relative(root, file)
    const path = [...trail, name]
    if (/^(agent\/|main\/agent-(supervisor|ipc)\.ts$)/.test(name)) throw new Error(`Forbidden Explain dependency: ${path.join(' -> ')}`)
    if (visited.has(name)) return
    visited.add(name)
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      const base = resolve(dirname(file), specifier)
      const candidates = extname(base) === '.ts' ? [base] : [base + '.ts', join(base, 'index.ts')]
      const target = candidates.find(candidate => { try { return statSync(candidate).isFile() } catch { return false } })
      if (!target) throw new Error(`Unresolved Explain dependency: ${name} -> ${specifier}`)
      visit(target, path)
    }
  }
  for (const entry of entries) visit(resolve(root, entry), [])
  return visited
}

describe('Explain import isolation', () => {
  it('rejects a forbidden transitive export even through a cycle and an explicit .ts import', () => {
    const root = temporaryDirectory()
    for (const [name, source] of Object.entries({
      'main/entry.ts': "import type { Value } from './bridge.ts'\nexport const value: Value = 1",
      'main/bridge.ts': "export * from './entry'\nexport { Value } from '../agent/private'",
      'agent/private.ts': 'export type Value = number',
    })) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), source)
    }
    expect(() => assertExplainIsolation(root, ['main/entry.ts'])).toThrow(/main\/entry.ts.*main\/bridge.ts.*agent\/private.ts/s)
  })

  it.each(['main/agent-supervisor.ts', 'main/agent-ipc.ts'])('rejects a hidden side-effect edge to %s', forbidden => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'main'))
    writeFileSync(join(root, 'main/entry.ts'), `import './${forbidden.slice(5, -3)}'`)
    writeFileSync(join(root, forbidden), '')
    expect(() => assertExplainIsolation(root, ['main/entry.ts'])).toThrow('Forbidden Explain dependency')
  })

  it('follows multiline imports, type re-exports, index modules and literal dynamic imports without reading comments or prompt strings', () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'safe'))
    writeFileSync(join(root, 'entry.ts'), `
      // import './agent/not-real'
      /* export * from './agent/also-not-real' */
      const prompt = "import './agent/quoted'"
      const template = \`export * from './agent/template'\`
      import type { Value\n } from './safe'
      export type { Value } from './types.ts'
      export const local = 1
      import('node:fs')
      import('./dynamic')
      import.meta.url
      require('./required')
    `)
    for (const name of ['safe/index.ts', 'types.ts', 'dynamic.ts', 'required.ts']) writeFileSync(join(root, name), 'export type Value = number')
    expect([...assertExplainIsolation(root, ['entry.ts'])].sort()).toEqual(['dynamic.ts', 'entry.ts', 'required.ts', 'safe/index.ts', 'types.ts'])
    expect(moduleSpecifiers("import { x } from 'external'; export { x }; require.resolve('external')")).toEqual(['external'])
    expect(() => moduleSpecifiers('import(variable)')).toThrow('Nonliteral module edge')
    writeFileSync(join(root, 'entry.ts'), "import './missing'")
    expect(() => assertExplainIsolation(root, ['entry.ts'])).toThrow('Unresolved Explain dependency')
  })

  it('keeps every real Explain and overlay entry transitively independent of the agent host and IPC', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const entries = ['main/voice/talk.ts', 'main/voice/brain.ts', 'main/answer-provider.ts', 'main/conversations.ts', 'main/history.ts', 'renderer/overlay.ts']
    const graph = assertExplainIsolation(root, entries)
    for (const entry of entries) expect(graph.has(entry)).toBe(true)
    expect(graph.has('shared/beats.ts')).toBe(true)
    expect(graph.has('renderer/model-stage.ts')).toBe(true)
  })
})

// Only the true external boundaries are fake: the provider's HTTP response and
// the utility-process channel. BeatParser, SDK streaming and SQLite are real.
const answerDeltas = ['The control saves your work.\n', '@circle 100 120 20\n', 'Choose it to continue.']
const answer = 'The control saves your work.\nChoose it to continue.'
function scriptedTransport() {
  const requests: unknown[] = []
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    const chunks = answerDeltas.map(content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null as string | null }] }))
    chunks.push({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })
    const body = chunks.map(chunk => `data: ${JSON.stringify({ id: 'scripted', model: 'fixture', created: 0, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', transport)
  return { requests, transport }
}
const start: HostCommand = { kind: 'start', requestId: 'background', goal: 'Background research', mode: 'web', persistence: 'temporary', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'compatible', model: 'fixture' } }
class Child extends EventEmitter {
  sent: MainToHost[] = []
  constructor(private readonly crashes = false) { super() }
  postMessage(message: MainToHost): void {
    this.sent.push(message)
    if (message.kind === 'init') queueMicrotask(() => this.emit('message', { v: 1, kind: 'ready' }))
    if (message.kind === 'command' && this.crashes) queueMicrotask(() => this.emit('exit', 1))
  }
  kill(): boolean { this.emit('exit', 0); return true }
}
function supervisor(crashes = false) {
  const spawn = vi.fn(() => new Child(crashes))
  const value = new AgentSupervisor({ spawn, credentials: async () => 'synthetic', onPush() {}, dataDir: temporaryDirectory() })
  return { value, spawn }
}
function explainFixture() {
  const path = join(temporaryDirectory(), 'history.sqlite')
  const conversations = new ConversationController(new HistoryRepository(path), () => DEFAULT_SETTINGS)
  let completed: (() => void) | undefined
  const capture: ScreenCaptures = { captureMs: 0, encodeMs: 0, displays: [{ displayId: 1, frame: { x: 0, y: 0, width: 1200, height: 800 }, pixelWidth: 1200, pixelHeight: 800, jpeg: Buffer.from('synthetic-fixture-pixels') }] }
  const draws: unknown[] = []
  const talk = new TalkSession({
    conversations, answer: () => ({ provider: 'compatible', model: 'fixture', baseURL: 'https://provider.invalid/v1', vision: true, credential: async () => 'synthetic' }),
    capture: async () => capture, audio: { send() {} }, onStatus() {},
    drawing: { draw: (...args) => draws.push(args), answerDone: () => completed?.() },
  })
  let closed = false
  const dispose = () => {
    if (closed) return
    closed = true
    talk.close(); conversations.close()
  }
  return {
    conversations, draws,
    async turn() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = new Promise<void>((resolve, reject) => { completed = resolve; timer = setTimeout(() => reject(new Error('Explain did not complete independently of the host.')), 2000) })
      const at = performance.now()
      try { expect(talk.askText('Where to save?')).toEqual({ accepted: true }); await done; return performance.now() - at }
      finally { clearTimeout(timer); completed = undefined }
    },
    closeAndRead() {
      const id = conversations.currentId!
      dispose()
      const reader = new HistoryRepository(path)
      try { return reader.turns(id) } finally { reader.close() }
    },
    dispose,
  }
}

it('makes exactly one real answer-model request per Explain turn across three turns while Do is pending, without another host spawn', async () => {
  const provider = scriptedTransport(), host = supervisor(), fixture = explainFixture()
  let settled = false
  const pending = host.value.request(start).catch(() => { settled = true })
  try {
    for (let i = 0; i < 3; i++) {
      await fixture.turn()
      expect(provider.transport).toHaveBeenCalledTimes(i + 1)
      expect(host.spawn).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      expect(fixture.conversations.turns()[i]).toMatchObject({ answer, state: 'complete', provider: 'compatible', model: 'fixture' })
    }
    expect(provider.requests.map(value => (value as { messages: { role: string }[] }).messages.filter(message => message.role === 'user').length)).toEqual([1, 2, 3])
    expect(fixture.draws).toHaveLength(3)
  } finally { fixture.dispose(); host.value.dispose(); await pending }
})

it.each(['never-started', 'frozen', 'crashing'] as const)('keeps Explain answer, beats, durable history and latency independent of a %s host', async mode => {
  scriptedTransport()
  const baseline = explainFixture()
  const baselineMs = await baseline.turn()
  const baselineDraws = baseline.draws.slice(), baselineTurn = baseline.closeAndRead()[0]!
  const host = supervisor(mode === 'crashing'), fixture = explainFixture()
  const pending: Promise<unknown>[] = []
  try {
    // Crash twice while actual requests are outstanding, not merely an idle host.
    const rounds = mode === 'crashing' ? 2 : 1
    for (let round = 0; round < rounds; round++) {
      if (mode !== 'never-started') pending.push(host.value.request({ ...start, requestId: `background-${round}` }).catch(error => error))
      const elapsed = await fixture.turn()
      // Provisional machine-local S3 threshold, not a production SLO.
      expect(elapsed).toBeLessThanOrEqual(baselineMs + Math.max(20, baselineMs * 0.5))
    }
    expect(host.spawn).toHaveBeenCalledTimes(mode === 'never-started' ? 0 : rounds)
    if (mode === 'crashing') expect(host.value.state).toBe('crashed')
    if (mode === 'frozen') expect(host.value.state).toBe('ready')
    expect(fixture.draws).toEqual(Array.from({ length: rounds }, () => baselineDraws).flat())
    const saved = fixture.closeAndRead()
    for (const turn of saved) {
      const { id: _id, conversationId: _conversation, created: _created, ...actual } = turn
      const { id: _baselineId, conversationId: _baselineConversation, created: _baselineCreated, ...expected } = baselineTurn
      expect(actual).toEqual(expected)
      expect(actual.scene.beats).not.toHaveLength(0)
      expect(JSON.stringify(actual)).not.toContain('synthetic-fixture-pixels')
    }
  } finally { baseline.dispose(); fixture.dispose(); host.value.dispose(); await Promise.all(pending) }
})

it('constructs a production AppShell and accepts Explain without spawning a host before the first Do request', async () => {
  electron.dir = temporaryDirectory()
  scriptedTransport()
  let done!: () => void
  const completed = new Promise<void>(resolve => { done = resolve })
  let talk!: TalkSession
  const shell = new AppShell({
    ask: question => talk.askText(question), stop() {}, clear() {}, replaceKey() {}, settingsChanged() {},
    agentConnection: () => ({ provider: 'compatible', model: 'fixture', vision: false, credential: async () => 'synthetic' }),
    permissions: () => ({ microphone: '', screen: '', input: '' }),
  })
  const frame = { url: pageURL('home') }, contents = { send() {}, mainFrame: frame, getURL: () => frame.url }
  shell.home = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  talk = new TalkSession({
    conversations: shell.conversations,
    answer: () => ({ provider: 'compatible', model: 'fixture', baseURL: 'https://provider.invalid/v1', vision: false, credential: async () => 'synthetic' }),
    capture: async () => undefined, audio: { send() {} }, onStatus: label => shell.setStatus(label), drawing: { draw() {}, answerDone: done },
  })
  try {
    expect(electron.handlers.has('heynimbo:agent-request')).toBe(true)
    expect(electron.fork).not.toHaveBeenCalled()
    shell.keyPresent = true
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    expect(await electron.handlers.get('heynimbo:app-request')!(event, { kind: 'ask', question: 'Where to save?' })).toEqual({ accepted: true })
    await completed
    expect(shell.conversations.turns()[0]).toMatchObject({ state: 'complete', answer })
    expect(electron.fork).not.toHaveBeenCalled()
    // Positive control: the same installed agent handler really owns spawn.
    electron.fork.mockImplementationOnce(() => { throw new Error('Synthetic spawn boundary failure') })
    await expect(electron.handlers.get('heynimbo:agent-request')!(event, { kind: 'start', requestId: 'first-do', goal: 'Research', mode: 'web' })).rejects.toThrow('Agent host unavailable. Try again.')
    expect(electron.fork).toHaveBeenCalledOnce()
  } finally { talk.close(); shell.home = undefined; shell.close() }
})
