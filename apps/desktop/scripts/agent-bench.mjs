// Run: node apps/desktop/scripts/agent-bench.mjs [--samples=7]
// Synthetic, no network/credentials. Node fork stands in for Electron's utility
// process; Vite's installed TS loader avoids compilation or new dependencies.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { MockLanguageModelV4 } from 'ai/test'

const self = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const usage = { inputTokens: { total: 2, noCache: 2 }, outputTokens: { total: 2000, text: 2000 } }
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const ms = value => Number(value.toFixed(3))
async function application() {
  const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, watch: null, ws: false, hmr: false }, appType: 'custom' })
  try {
    const modules = await Promise.all(['main/voice/talk', 'main/conversations', 'main/history', 'main/settings', 'main/agent-supervisor', 'agent/runtime', 'agent/store', 'agent/artifacts', 'agent/html-text', 'agent/host/serve', 'shared/agent-protocol'].map(name => server.ssrLoadModule(`/src/${name}.ts`)))
    return { ...Object.assign({}, ...modules), close: () => server.close() }
  } catch (error) { await server.close(); throw error }
}

// Exported so the same load generator is exercised inside the test process as
// well as across a real process boundary by the standalone benchmark.
export function createAgentLoad(app, { count, extraction, sink, streaming = () => {}, completed = () => {} }) {
  const store = new app.MemoryAgentStore(), memoryStore = new app.MemoryAgentStore()
  const terminal = new Map()
  const metrics = { completed: 0, deltas: 0, partials: 0, extractionBytes: 0, extractionMs: 0, extractionStarted: 0, extractionEnded: 0 }
  const htmlBytes = 5 * 1024 * 1024
  const fragment = '<p>Bounded synthetic source evidence &amp; detail.</p>'
  const html = extraction ? ('<title>Fixture</title>' + fragment.repeat(Math.ceil(htmlBytes / fragment.length))).slice(0, htmlBytes) : ''
  let models = 0, entered = 0
  let extractionTimer
  function extractPage() {
    metrics.extractionStarted = Date.now()
    const at = performance.now(), page = app.htmlToText(html, 200_000, 'https://example.invalid')
    metrics.extractionMs = ms(performance.now() - at)
    metrics.extractionEnded = Date.now(); metrics.extractionBytes = Buffer.byteLength(html)
    assert.equal(page.title, 'Fixture'); assert.ok(page.text.includes('Bounded synthetic source evidence'))
  }
  const runtime = app.createAgentRuntime({
    store, memoryStore, artifacts: new app.MemoryArtifactStore(), memoryArtifacts: new app.MemoryArtifactStore(), credentials: async () => '', tools: () => [],
    models: async () => {
      const extracts = extraction && models++ === 0
      return new MockLanguageModelV4({ doStream: async () => {
        return { stream: new ReadableStream({ async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 'text' })
          if (++entered === count) streaming()
          for (let batch = 0; batch < 100; batch++) {
            for (let i = 0; i < 20; i++) { controller.enqueue({ type: 'text-delta', id: 'text', delta: 'x' }); metrics.deltas++ }
            // Extraction overlaps Explain's sample window, not just setup.
            if (extracts && batch === 4) extractionTimer = setTimeout(extractPage, 5)
            await delay(5)
          }
          controller.enqueue({ type: 'text-end', id: 'text' })
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'scripted' }, usage })
          controller.close()
        } }) }
      } })
    },
    sink: {
      partial(...args) { metrics.partials++; sink.partial(...args) },
      events(events, runs) {
        sink.events(events, runs)
        for (const event of events) if (event.payload.type === 'status' && app.isTerminal(event.payload.status)) terminal.set(event.runId, event.payload.status)
        if (terminal.size === count) {
          assert.ok([...terminal.values()].every(status => status === 'succeeded'), 'Background run failed')
          metrics.completed = terminal.size
          completed({ ...metrics })
        }
      },
    },
  })
  return { runtime, async close() { clearTimeout(extractionTimer); await runtime.shutdown(); store.close(); memoryStore.close() } }
}

export async function serveBenchmarkHost(app, port, { count, extraction, notify }) {
  let load
  const adapter = app.serveHost(port, async init => {
    load = createAgentLoad(app, { count, extraction, sink: init.sink, streaming: () => notify({ kind: 'bench.streaming' }), completed: metrics => notify({ kind: 'bench.completed', metrics }) })
    return load.runtime
  })
  notify({ kind: 'bench.ready' })
  return { async close() { await adapter.dispose(); await load?.close() } }
}
async function host(count, extraction) {
  const app = await application()
  const adapter = await serveBenchmarkHost(app, { postMessage: message => process.send(message), on: (_event, listener) => process.on('message', listener) }, { count, extraction, notify: message => process.send(message) })
  process.once('disconnect', async () => { await adapter.close(); await app.close() })
}
export function waitForHostMessage(child, kind, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const receive = value => { if (value.kind === kind) { cleanup(); resolve(value) } }
    const exit = () => { cleanup(); reject(new Error(`Benchmark host exited before ${kind}`)) }
    const error = () => { cleanup(); reject(new Error(`Benchmark host failed before ${kind}`)) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Benchmark host timed out before ${kind}`)) }, timeoutMs)
    function cleanup() { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); child.off('error', error) }
    child.on('message', receive); child.once('exit', exit); child.once('error', error)
  })
}
async function background(app, count, extraction) {
  const child = fork(self, ['--host', String(count), extraction ? 'extract' : 'stream'], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  // Observe early rejections immediately; still await the original promises so
  // a crash can never be converted into a plausible-looking measurement.
  void exited.catch(() => {})
  let supervisor
  try {
    await waitForHostMessage(child, 'bench.ready')
    const started = waitForHostMessage(child, 'bench.streaming'), done = waitForHostMessage(child, 'bench.completed')
    void started.catch(() => {}); void done.catch(() => {})
    // Side-band benchmark messages never enter the actual host protocol parser.
    supervisor = new app.AgentSupervisor({
      dataDir: process.env.TMPDIR ?? root, credentials: async () => '', onPush() {},
      spawn: () => ({ pid: child.pid, postMessage: value => child.send(value), on: (event, listener) => child.on(event, event === 'message' ? value => { if (value.v === 1) listener(value) } : listener), kill: () => child.kill() }),
    })
    await Promise.all(Array.from({ length: count }, (_, i) => supervisor.request({ kind: 'start', requestId: `bench-${i}`, goal: 'Synthetic background research', mode: 'web', persistence: 'temporary', grants: [], budget: app.DEFAULT_BUDGET, model: { provider: 'mock', model: 'scripted' } })))
    await started
    return { done, async close() { supervisor.dispose(); await exited } }
  } catch (error) { supervisor?.dispose(); child.kill('SIGKILL'); await exited.catch(() => {}); throw error }
}

export async function runBenchmark({ samples = 7 } = {}) {
  assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 50, 'samples must be an integer from 3 to 50')
  const app = await application(), oldFetch = globalThis.fetch, oldInfo = console.info
  const conversations = new app.ConversationController(new app.HistoryRepository(), () => app.DEFAULT_SETTINGS)
  let calls = 0, current, finish
  // This boundary drives the real compatible-provider SDK and BeatParser; no
  // mock of streamProviderAnswer, TalkSession or the answer coordinator.
  globalThis.fetch = async () => {
    calls++
    return new Response(new ReadableStream({ async start(controller) {
      const encode = value => new TextEncoder().encode(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture', created: 0, choices: [{ index: 0, delta: { content: value }, finish_reason: null }] })}\n\n`)
      for (const text of ['A ', 'bounded ', 'synthetic ', 'answer.']) { controller.enqueue(encode(text)); await delay(10) }
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }
  console.info = (...args) => {
    // Existing TalkSession timing mark, rounded to ms by production code.
    const match = /^\[talk\] after release:.*first token (\d+)ms/.exec(String(args[0]))
    if (match && current) current.firstTokenMs = Number(match[1])
    else oldInfo(...args)
  }
  const talk = new app.TalkSession({
    conversations, answer: () => ({ provider: 'compatible', model: 'fixture', baseURL: 'https://provider.invalid/v1', vision: false, credential: async () => 'synthetic' }), capture: async () => undefined, audio: { send() {} }, onStatus() {}, drawing: { draw() {}, answerDone: () => finish() },
  })
  async function turn() {
    conversations.reset()
    const started = Date.now(), at = performance.now()
    current = { firstTokenMs: -1, totalMs: 0 }
    let timer
    try {
      await new Promise((resolve, reject) => { finish = resolve; timer = setTimeout(() => reject(new Error('Explain benchmark turn timed out')), 3000); talk.askText('Explain the fixture.') })
      current.totalMs = ms(performance.now() - at)
      assert.ok(current.firstTokenMs >= 0, 'TalkSession did not emit first-token timing')
      assert.equal(conversations.turns()[0].state, 'complete')
      assert.equal(conversations.turns()[0].answer, 'A bounded synthetic answer.')
      return { ...current, started, ended: Date.now() }
    } finally { clearTimeout(timer) }
  }
  try {
    await turn() // Warm the SDK/TS modules before measuring S0; not cold-launch S5.
    const scenarios = []
    for (const [name, count, extraction] of [['S0', 0, false], ['S1', 1, false], ['S2', 3, true]]) {
      const load = count ? await background(app, count, extraction) : undefined
      const lag = monitorEventLoopDelay({ resolution: 1 }), before = calls
      lag.enable(); await delay(10)
      try {
        const measurements = []
        for (let i = 0; i < samples; i++) measurements.push(await turn())
        const loop = { p50Ms: ms(lag.percentile(50) / 1e6), p99Ms: ms(lag.percentile(99) / 1e6) }
        lag.disable()
        const metrics = load ? (await load.done).metrics : undefined
        if (metrics) metrics.overlapsExplain = measurements.some(sample => sample.started <= metrics.extractionEnded && sample.ended >= metrics.extractionStarted)
        scenarios.push({ name, samples: measurements, providerRequests: calls - before, firstTokenMedianMs: median(measurements.map(value => value.firstTokenMs)), totalMedianMs: median(measurements.map(value => value.totalMs)), loop, ...(metrics ? { load: metrics } : {}) })
      } finally { lag.disable(); await load?.close() }
    }
    return { node: process.version, platform: `${process.platform}/${process.arch}`, samples, timing: 'TalkSession first-token mark (1ms resolution); askText to answerDone; warm in-memory history; scripted 40ms answer; isolated Node host', scenarios }
  } finally { talk.close(); conversations.close(); globalThis.fetch = oldFetch; console.info = oldInfo; await app.close() }
}

export async function main(args = process.argv.slice(2), write = console.log) {
  if (args[0] === '--host') return host(Number(args[1]), args[2] === 'extract')
  const samples = Number(args.find(arg => arg.startsWith('--samples='))?.split('=')[1] ?? 7)
  const report = await runBenchmark({ samples })
  write(`M8 synthetic benchmark | ${report.node} ${report.platform} | ${report.samples} turns/scenario`)
  write(report.timing)
  for (const scenario of report.scenarios) write(`${scenario.name}: TTFT median=${scenario.firstTokenMedianMs}ms total median=${scenario.totalMedianMs}ms loop p50=${scenario.loop.p50Ms}ms p99=${scenario.loop.p99Ms}ms requests=${scenario.providerRequests}${scenario.load ? ` completed=${scenario.load.completed} partials=${scenario.load.partials} extraction=${scenario.load.extractionBytes}B/${scenario.load.extractionMs}ms overlap=${scenario.load.overlapsExplain}` : ''}`)
  write('BENCH_JSON ' + JSON.stringify(report))
  return report
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
