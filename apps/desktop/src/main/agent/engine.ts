import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { TurnStep } from '../../shared/app'
import type { Speed } from '../../shared/providers'
import type { AnswerConnection } from '../answer-provider'
import { KEY_REJECTED } from '../model-catalog'
import type { Exchange, Screenshot } from '../voice/brain'
import { judge, show, type Approval } from './policy'
import { fileTools } from './files'
import { webTools } from './web'

type Pi = typeof import('@earendil-works/pi-coding-agent')
export type ApprovalAnswer = 'once' | 'conversation' | 'deny'
export interface AgentDeps {
  dataDir: string
  /** The folder the agent may change freely. Default: ~/HeyNimbo. */
  workspace?: string
  /** Asks the owner; resolves 'deny' when the turn is stopped first. */
  approve: (approval: Approval, signal: AbortSignal) => Promise<ApprovalAnswer>
}
export interface TurnInput {
  conversationId: string
  connection: AnswerConnection
  instructions: string
  question: string
  /** Facts about this turn only: pointer, screenshot size or canvas. */
  note: string
  screenshot?: Screenshot
  /** Saved exchanges, used once to seed a conversation this run has not seen yet. */
  history: readonly Exchange[]
  signal: AbortSignal
  onStep: (steps: TurnStep[]) => void
}
/** `signal` is the running turn's own cancellation, so a stopped or abandoned turn closes its approval sheet. */
interface Live { session: AgentSession; allowed: Set<string>; approved: Set<string>; signal?: AbortSignal; speed?: Speed }

const PI_PROVIDERS: Record<AnswerConnection['provider'], string> = { openai: 'openai', chatgpt: 'openai', anthropic: 'anthropic', google: 'google', deepseek: 'deepseek', openrouter: 'openrouter', compatible: 'compatible' }
// `tools` is an allowlist, so it names the custom web tools too.
const TOOLS = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'web_search', 'web_fetch']
const MAX_SESSIONS = 8
const LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  web_search: args => `Searched the web for “${String(args.query ?? '').slice(0, 80)}”`,
  web_fetch: args => `Read ${String(args.url ?? '').slice(0, 100)}`,
  read: args => `Read ${String(args.path ?? '')}`,
  grep: args => `Searched files for “${String(args.pattern ?? '').slice(0, 60)}”`,
  find: args => `Looked for ${String(args.pattern ?? 'files')}`,
  ls: args => `Listed ${String(args.path ?? 'the folder')}`,
  write: args => `Wrote ${String(args.path ?? '')}`,
  edit: args => `Edited ${String(args.path ?? '')}`,
  bash: args => `Ran ${String(args.command ?? '').split('\n')[0]!.slice(0, 100)}`,
}
const stepLabel = (tool: string, args: unknown): string => (LABELS[tool]?.((args ?? {}) as Record<string, unknown>) ?? `Used ${tool}`).replace(/[\x00-\x1f\x7f]/g, ' ')

/** The one HeyNimbo agent: a Pi session per conversation that explains, draws and does real work with tools. */
export class NimboAgent {
  readonly workspace: string
  private pi?: Promise<{ pi: Pi; runtime: ModelRuntime }>
  private readonly sessions = new Map<string, Live>()
  /** The run each conversation is busy with, so turns never overlap on one session. */
  private readonly runs = new Map<string, Promise<void>>()

  constructor(private readonly deps: AgentDeps) { this.workspace = deps.workspace ?? join(homedir(), 'HeyNimbo') }

  private load(): Promise<{ pi: Pi; runtime: ModelRuntime }> {
    const agentDir = join(this.deps.dataDir, 'agent')
    // Pi is ESM-only; its state lives in HeyNimbo's own folder, never in the owner's ~/.pi.
    return this.pi ??= import('@earendil-works/pi-coding-agent').then(async pi => ({
      pi, runtime: await pi.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') }),
    }))
  }

  /** Pi's catalog model, or one built from a sibling for IDs Pi does not list yet and for custom endpoints. */
  private model(runtime: ModelRuntime, connection: AnswerConnection): Model<Api> {
    const provider = PI_PROVIDERS[connection.provider]
    const input: Model<Api>['input'] = connection.vision ? ['text', 'image'] : ['text']
    if (provider === 'compatible') return {
      id: connection.model, name: connection.model, api: 'openai-completions', provider, baseUrl: connection.baseURL!, reasoning: false, input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    } as Model<Api>
    const known = runtime.getModel(provider, connection.model)
    if (known) return known
    // The closest-named model (gpt-6.1-terra → gpt-6.1-sol), larger output limit on ties: the first
    // listed model can be an old one whose small limit cuts reasoning models off mid-sentence.
    const shared = (id: string): number => { let i = 0; while (i < id.length && id[i] === connection.model[i]) i++; return i }
    const sibling = runtime.getModels(provider).reduce<Model<Api> | undefined>((best, model) => !best || shared(model.id) > shared(best.id) || (shared(model.id) === shared(best.id) && model.maxTokens > best.maxTokens) ? model : best, undefined)
    if (!sibling) throw new Error('This answer provider is not supported for tasks.')
    return { ...sibling, id: connection.model, name: connection.model, input }
  }

  private async session(input: TurnInput, model: Model<Api>): Promise<{ live: Live; fresh: boolean }> {
    const existing = this.sessions.get(input.conversationId)
    if (existing) {
      this.sessions.delete(input.conversationId); this.sessions.set(input.conversationId, existing)
      // The endpoint is part of the model: a key saved for one endpoint must never reach another.
      const current = existing.session.model
      if (current?.id !== model.id || current?.provider !== model.provider || current?.baseUrl !== model.baseUrl || current?.api !== model.api) await existing.session.setModel(model)
      return { live: existing, fresh: false }
    }
    const { pi, runtime } = await this.load()
    const agentDir = join(this.deps.dataDir, 'agent')
    mkdirSync(this.workspace, { recursive: true })
    const live: Live = { allowed: new Set(), approved: new Set() } as Live
    const loader = new pi.DefaultResourceLoader({
      cwd: this.workspace, agentDir, noExtensions: true, noPromptTemplates: true, noThemes: true,
      systemPromptOverride: () => input.instructions,
      extensionFactories: [api => {
        api.on('tool_call', async event => {
          const args = event.input as Record<string, unknown>
          const verdict = judge(event.toolName, args, this.workspace, this.deps.dataDir)
          if (verdict.kind === 'deny') return { block: true, reason: verdict.reason }
          if (verdict.kind === 'allow' || live.allowed.has(event.toolName)) return undefined
          const answer = await this.deps.approve(verdict.approval, live.signal ?? AbortSignal.abort())
          if (answer === 'conversation') live.allowed.add(event.toolName)
          return answer === 'deny' ? { block: true, reason: 'The owner declined this action. Do not retry it; say what you could not do.' } : undefined
        })
      }],
    })
    await loader.reload()
    const { session } = await pi.createAgentSession({
      cwd: this.workspace, agentDir, model, modelRuntime: runtime, resourceLoader: loader, tools: TOOLS,
      customTools: [...fileTools(pi, {
        workspace: this.workspace, dataDir: this.deps.dataDir, approved: live.approved, everywhere: () => live.allowed.has('write'),
        approve: async folder => {
          const answer = await this.deps.approve({ tool: 'write', title: 'Let HeyNimbo change files in this folder?', detail: show(folder) }, live.signal ?? AbortSignal.abort())
          if (answer === 'conversation') live.allowed.add('write')
          return answer !== 'deny'
        },
      }), ...webTools()],
      sessionManager: pi.SessionManager.inMemory(this.workspace),
      // Screenshot pixels are the drawing coordinate space, so images are never resized.
      settingsManager: pi.SettingsManager.inMemory({ images: { autoResize: false }, retry: { enabled: true, maxRetries: 2 } }),
    })
    live.session = session
    // OpenAI's Fast and Ultrafast tiers are a request field Pi's agent never sets. Every request,
    // compaction included, goes through this one stream function, so the tier is added here.
    const stream = session.agent.streamFunction
    session.agent.streamFunction = (model, context, options) => !live.speed || model.api !== 'openai-responses' ? stream(model, context, options) : stream(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => ({ ...((await options?.onPayload?.(payload, payloadModel)) ?? payload) as object, service_tier: live.speed }),
    })
    this.sessions.set(input.conversationId, live)
    while (this.sessions.size > MAX_SESSIONS) this.drop(this.sessions.keys().next().value!)
    return { live, fresh: true }
  }

  /** Streams the spoken text of one turn; tool use in between is reported through `onStep`.
   *  Turns of one conversation run one at a time: a new turn waits for a stopped one to settle. */
  async *answer(input: TurnInput): AsyncGenerator<string> {
    const previous = this.runs.get(input.conversationId)
    let release!: () => void
    const mine = new Promise<void>(resolve => { release = resolve })
    this.runs.set(input.conversationId, mine)
    const stopped = (): void => { if (input.signal.aborted) throw new Error('The answer was interrupted.') }
    let live: Live | undefined, run: Promise<void> | undefined, done = false
    let unsubscribe = (): void => {}
    // The turn's own cancellation also fires when the consumer stops early, so a pending approval closes.
    const cancel = new AbortController()
    const stop = (): void => { cancel.abort(); void live?.session.abort() }
    try {
      await previous
      stopped()
      const { runtime } = await this.load()
      const model = this.model(runtime, input.connection)
      const key = await input.connection.credential()
      stopped()
      await runtime.setRuntimeApiKey(model.provider, key || 'none')
      const created = await this.session(input, model)
      stopped()
      live = created.live
      const { session } = live
      session.setThinkingLevel(model.reasoning && input.connection.effort && ['low', 'medium', 'high'].includes(input.connection.effort) ? input.connection.effort : 'off')
      live.signal = cancel.signal
      live.speed = input.connection.provider === 'openai' ? input.connection.speed : undefined
      live.approved.clear()

      const queue: string[] = [], steps: TurnStep[] = [], ids = new Map<string, number>()
      let wake: (() => void) | undefined, failure: string | undefined, spoke = false
      const notify = (): void => { wake?.(); wake = undefined }
      unsubscribe = session.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') { queue.push(event.assistantMessageEvent.delta); spoke = true }
        else if (event.type === 'message_end' && event.message.role === 'assistant') {
          // Each step is its own message. A line break ends its last sentence now, so "I'll look that up"
          // is spoken while the tool runs instead of after it, and keeps drawing lines apart.
          if (spoke) queue.push('\n')
          // The last attempt decides: a retry that succeeds clears an earlier error.
          failure = event.message.stopReason === 'error' ? event.message.errorMessage ?? 'error' : event.message.stopReason === 'length' ? 'length' : undefined
        }
        else if (event.type === 'tool_execution_start') {
          console.info(`[agent] ${event.toolName}`)
          ids.set(event.toolCallId, steps.push({ label: stepLabel(event.toolName, event.args), state: 'running' }) - 1)
          input.onStep([...steps])
        } else if (event.type === 'tool_execution_end') {
          const step = steps[ids.get(event.toolCallId) ?? -1]
          if (step) { step.state = event.isError ? 'failed' : 'done'; input.onStep([...steps]) }
        } else return
        notify()
      })
      input.signal.addEventListener('abort', stop, { once: true })
      const earlier = created.fresh && input.history.length ? `Earlier in this conversation:\n${input.history.map(e => `User: ${e.question}\nYou: ${e.answer}`).join('\n\n')}\n\n` : ''
      const images = input.connection.vision && input.screenshot ? [{ type: 'image' as const, data: input.screenshot.jpeg.toString('base64'), mimeType: 'image/jpeg' }] : undefined
      run = session.prompt(`${earlier}${input.question}\n\n(${input.note})`, { images, expandPromptTemplates: false })
        .catch((error: unknown) => { failure ??= error instanceof Error ? error.message : String(error) })
        .finally(() => { done = true; notify() })
      for (;;) {
        while (queue.length) yield queue.shift()!
        if (done) break
        await new Promise<void>(resolve => { wake = resolve })
      }
      await run
      stopped()
      if (failure === 'length') throw new Error('The answer was cut off at the model\'s output limit. Ask again or choose a lower reasoning effort.')
      if (failure) throw new Error(/\b401\b|invalid.{0,20}(api.?key|x-api-key)|authentication/i.test(failure) ? KEY_REJECTED : 'The answer provider could not complete this request. Check the connection, selected model and usage limits in Settings.')
    } finally {
      unsubscribe(); input.signal.removeEventListener('abort', stop); cancel.abort()
      if (run && !done) { await live?.session.abort(); await run }
      if (live?.signal === cancel.signal) live.signal = undefined
      if (this.runs.get(input.conversationId) === mine) this.runs.delete(input.conversationId)
      release()
    }
  }

  /** Forgets one conversation's working memory, or every conversation's when no ID is given. */
  drop(conversationId?: string): void {
    for (const id of conversationId === undefined ? [...this.sessions.keys()] : [conversationId]) {
      this.sessions.get(id)?.session.dispose()
      this.sessions.delete(id)
    }
  }

  close(): void { this.drop() }
}
