import { createHash, randomUUID } from 'node:crypto'
import { UnsupportedFunctionalityError, isStepCount, modelMessageSchema, jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from 'ai'
import { isTerminal, type AgentEvent, type AgentEventPayload, type HostCommand, type RunSummary, type AgentError } from '../shared/agent-protocol'
import type { AgentRuntime, AgentTool, AgentStore, ArtifactStore, RunRecord, RuntimeDeps, StepCheckpoint } from './contracts'
import { DO_INSTRUCTIONS } from './prompt'

type Binding = { store: AgentStore; artifacts: ArtifactStore; eventCallIds?: Map<string, string> }
type Decision = 'approved' | 'denied'
type Wait<T> = { id: string; resolve(value: T): void; reject(error: Error): void }
type Running = Binding & {
  run: RunRecord
  controller: AbortController
  task: Promise<void>
  approval?: Wait<Decision>
  question?: Wait<string>
  wallTimer?: ReturnType<typeof setTimeout>
  deadline: number
  outputBytes: number
  outputExhausted: boolean
  partialTimer?: ReturnType<typeof setTimeout>
  partialText?: string
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry)
}

class BudgetError extends Error {}
const PROVIDER_ERROR = 'The model provider could not complete this run. Check the connection and selected model, then Continue.'
function boundedText(text: string, bytes: number): string {
  const buffer = Buffer.from(text.slice(0, bytes))
  let end = Math.min(bytes, buffer.byteLength)
  while (end > 0 && end < buffer.byteLength && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

export function createAgentRuntime(deps: RuntimeDeps): AgentRuntime {
  const now = () => deps.clock?.now() ?? Date.now()
  const active = new Map<string, Running>()
  const flights = new Set<Promise<unknown>>()
  let closing = false
  let pending: AgentEvent[] = []
  const affected = new Map<string, Binding>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flushMs = deps.flushMs ?? 16
  function flush() {
    clearTimeout(flushTimer)
    flushTimer = undefined
    if (!pending.length) return
    const events = pending
    pending = []
    const runs = [...affected].flatMap(([id, binding]) => { const run = binding.store.getRun(id); return run ? [summary(run)] : [] })
    affected.clear()
    deps.sink.events(events, runs)
  }
  function summary(run: RunSummary): RunSummary {
    return { id: run.id, goal: run.goal, mode: run.mode, mixed: run.mixed, status: run.status, persistence: run.persistence, created: run.created, updated: run.updated, usage: { ...run.usage }, ...(run.conversationId ? { conversationId: run.conversationId } : {}), ...(run.error ? { error: run.error } : {}) }
  }
  function emit(state: Binding, id: string, payload: AgentEventPayload, immediate = false) {
    // Provider IDs are opaque. Timeline IDs are host-owned; this mapping never
    // changes the provider IDs in the checkpoint or in the SDK transcript.
    if ('callId' in payload) {
      const ids = state.eventCallIds ??= new Map<string, string>()
      if (!ids.has(payload.callId)) ids.set(payload.callId, randomUUID())
      payload = { ...payload, callId: ids.get(payload.callId)! }
    }
    pending.push(state.store.appendEvent(id, payload, now()))
    affected.set(id, state)
    if (immediate) flush()
    else flushTimer ??= setTimeout(flush, flushMs)
  }
  function status(state: Running, value: RunRecord['status'], error?: AgentError) {
    state.run.status = value
    state.store.setStatus(state.run.id, value, now(), error)
    emit(state, state.run.id, { type: 'status', status: value }, isTerminal(value) || value === 'waiting_approval' || value === 'waiting_user')
  }
  function find(id: string): Binding {
    const cached = active.get(id)
    if (cached) return cached
    const store = deps.memoryStore.getRun(id) ? deps.memoryStore : deps.store.getRun(id) ? deps.store : undefined
    if (!store) throw new Error('Run not found.')
    const binding = { store, artifacts: store === deps.memoryStore ? deps.memoryArtifacts : deps.artifacts }
    return binding
  }
  function checkpoint(state: Running) {
    state.controller.signal.throwIfAborted()
    if (now() >= state.deadline) {
      fail(state, { code: 'budget', message: 'The run wall-time budget was exhausted.' })
      state.controller.signal.throwIfAborted()
    }
    if (active.get(state.run.id) !== state) throw new Error('Run is no longer active.')
  }
  function consume(state: Running, text: string) {
    const remaining = Math.max(0, state.run.budget.maxToolOutputBytes - state.outputBytes)
    state.outputExhausted ||= text.length > remaining || Buffer.byteLength(text) >= remaining
    const content = boundedText(text, remaining)
    state.outputBytes += Buffer.byteLength(content)
    return content
  }
  function fail(state: Running, error: AgentError) {
    if (state.controller.signal.aborted || isTerminal(state.run.status)) return
    emit(state, state.run.id, { type: 'error', ...error })
    status(state, 'failed', error)
    clearTimeout(state.partialTimer)
    clearTimeout(state.wallTimer)
    state.controller.abort()
    state.approval?.reject(new Error('Run stopped.'))
    state.approval = undefined
    state.question?.reject(new Error('Run stopped.'))
    state.question = undefined
  }
  function cancel(state: Running) {
    if (state.controller.signal.aborted || isTerminal(state.run.status)) return
    clearTimeout(state.partialTimer)
    clearTimeout(state.wallTimer)
    state.controller.abort()
    state.approval?.reject(new Error('Run cancelled.'))
    state.approval = undefined
    state.question?.reject(new Error('Run cancelled.'))
    state.question = undefined
    status(state, 'cancelled')
  }
  function scopedArtifacts(state: Running): ArtifactStore {
    const check = (id: string) => { checkpoint(state); if (id !== state.run.id) throw new Error('Artifact access denied.') }
    return {
      async save(runId, name, mediaType, content) {
        check(runId)
        const meta = await state.artifacts.save(runId, name, mediaType, content)
        try { checkpoint(state) } catch (error) {
          // A cancelled save has no event/reference for deleteRun to discover.
          await state.artifacts.delete([meta.id])
          throw error
        }
        emit(state, runId, { type: 'artifact', artifactId: meta.id, name: meta.name, mediaType: meta.mediaType, bytes: meta.bytes })
        return meta
      },
      async read(runId, id) { check(runId); return state.artifacts.read(runId, id) },
      async delete() { throw new Error('Tools cannot delete artifacts.') },
    }
  }
  async function execute(state: Running, command: Pick<Extract<HostCommand, { kind: 'start' }>, 'model' | 'search'>, resume?: StepCheckpoint) {
    const id = state.run.id
    // Wall time is per activation; persisted step/token/output budgets remain cumulative.
    state.wallTimer = setTimeout(() => fail(state, { code: 'budget', message: 'The run wall-time budget was exhausted.' }), Math.max(0, state.deadline - now()))
    try {
      checkpoint(state)
      if (state.run.usage.outputTokens >= state.run.budget.maxOutputTokens) throw new BudgetError('The output-token budget was exhausted.')
      if ((resume?.step ?? 0) >= state.run.budget.maxSteps) throw new BudgetError('The model-step budget was exhausted.')
      const askUser: AgentTool = {
        name: 'ask_user', description: 'Ask the owner a necessary task question. Never ask for credentials.', scope: 'any', effect: 'interaction',
        inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 16000 } }, required: ['question'], additionalProperties: false },
        parse(input) {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('question' in input) || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 16000) throw new Error('Invalid question.')
          return { question: input.question }
        },
        needsApproval: () => false, preview: () => 'Ask the owner',
        async execute(input) {
          checkpoint(state)
          const questionId = randomUUID()
          const answer = new Promise<string>((resolve, reject) => { state.question = { id: questionId, resolve, reject } })
          emit(state, id, { type: 'question', questionId, text: (input as { question: string }).question })
          status(state, 'waiting_user')
          return { ok: true, content: await answer, summary: 'Owner answered the question.' }
        },
      }
      const available = [...deps.tools({ search: command.search, credentials: deps.credentials }), askUser]
      let messages: ModelMessage[] = resume ? modelMessageSchema.array().parse(JSON.parse(resume.messages)) : [{ role: 'user', content: state.run.goal }]
      // Only completed results in the durable transcript are replayed. The MVP
      // has no external writes; an unfinished read may be retried after a crash.
      state.outputBytes = messages.reduce((sum, message) => sum + (message.role === 'tool' ? message.content.reduce((bytes, part) => bytes + (part.type === 'tool-result' && part.output.type === 'text' ? Buffer.byteLength(part.output.value) : 0), 0) : 0), 0)
      const seenCalls = new Set(messages.flatMap(message => message.role === 'tool' ? message.content.flatMap(part => part.type === 'tool-result' ? [part.toolCallId] : []) : []))
      state.outputExhausted = state.outputBytes >= state.run.budget.maxToolOutputBytes
      if (state.outputExhausted) throw new BudgetError('The tool-output byte budget was exhausted.')
      const model = await deps.models(command.model, deps.credentials)
      checkpoint(state)
      const artifacts = scopedArtifacts(state)
      for (let step = (resume?.step ?? 0) + 1; step <= state.run.budget.maxSteps; step++) {
        // An owner decision changes exposure only at the next step boundary.
        const mixed = state.run.mixed
        const allowed = (entry: AgentTool) => entry.scope === 'any' || entry.scope === state.run.mode || mixed
        let executions = 0
        const tools: ToolSet = Object.fromEntries(available.map(entry => [entry.name, tool({
          description: entry.description, inputSchema: jsonSchema(entry.inputSchema),
          execute: async (input, options) => {
            checkpoint(state)
            if (++executions > 128) { fail(state, { code: 'budget', message: 'The per-step tool-call budget was exhausted.' }); checkpoint(state) }
            if (state.outputExhausted) { fail(state, { code: 'budget', message: 'The tool-output byte budget was exhausted.' }); checkpoint(state) }
            try {
              if (seenCalls.has(options.toolCallId)) {
                const reason = 'This tool call already completed. Use the saved result instead of repeating its effect.'
                emit(state, id, { type: 'tool.denied', callId: options.toolCallId, reason })
                return consume(state, reason)
              }
              seenCalls.add(options.toolCallId)
              const normalized = entry.parse(input)
              if (!allowed(entry)) {
                const reason = 'The owner must explicitly allow mixing local files and web access before this tool can run.'
                emit(state, id, { type: 'tool.denied', callId: options.toolCallId, reason })
                return consume(state, reason)
              }
              if (entry.needsApproval(normalized, { grants: state.run.grants })) {
                const preview = entry.preview(normalized).slice(0, 8000)
                const digest = createHash('sha256').update(`${entry.name}\n${canonical(normalized)}`).digest('hex')
                const approvalId = randomUUID()
                const decision = new Promise<Decision>((resolve, reject) => { state.approval = { id: approvalId, resolve, reject } })
                emit(state, id, { type: 'approval.requested', approvalId, callId: options.toolCallId, tool: entry.name, preview, digest })
                status(state, 'waiting_approval')
                if (await decision === 'denied') {
                  emit(state, id, { type: 'tool.denied', callId: options.toolCallId, reason: 'The owner denied this tool call.' })
                  return consume(state, 'The owner denied this tool call. Do not work around the denial.')
                }
              }
              checkpoint(state)
              emit(state, id, { type: 'tool.call', step, callId: options.toolCallId, tool: entry.name, input: JSON.stringify(normalized).slice(0, 8000) })
              const flight = entry.execute(normalized, { runId: id, grants: state.run.grants, signal: state.controller.signal, checkpoint: () => checkpoint(state), artifacts, outputBudget: Math.max(0, state.run.budget.maxToolOutputBytes - state.outputBytes) })
              flights.add(flight)
              const outcome = await flight.finally(() => { flights.delete(flight) })
              checkpoint(state)
              emit(state, id, { type: 'tool.result', callId: options.toolCallId, ok: outcome.ok, summary: outcome.summary.slice(0, 8000), ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}) })
              return consume(state, outcome.content)
            } catch {
              checkpoint(state)
              const message = 'The tool could not complete this request. Check its input and permissions.'
              emit(state, id, { type: 'tool.result', callId: options.toolCallId, ok: false, summary: message })
              return consume(state, message)
            }
          },
        })]))
        // One SDK step at a time makes each completed message checkpoint durable
        // before the next model request. Tool execution still belongs to streamText.
        const result = streamText({ model, instructions: `${DO_INSTRUCTIONS}\nRun mode: ${state.run.mode}. Owner allowed mixing: ${mixed}.\nFolder grants: ${JSON.stringify(state.run.grants.map(({ id, label }) => ({ id, label })))}`, tools, activeTools: available.filter(allowed).map(entry => entry.name), messages, maxOutputTokens: Math.max(1, state.run.budget.maxOutputTokens - (state.store.getRun(id)?.usage.outputTokens ?? 0)), stopWhen: isStepCount(1), toolCallConcurrency: 1, maxRetries: 0, streamRetries: 0, abortSignal: state.controller.signal, onError: () => {} })
        let text = ''
        let wireTextUnits = 2
        let calls = 0
        const rejected = new Map<string, string>()
        for await (const part of result.fullStream) {
          checkpoint(state)
          if (part.type === 'tool-call' && ++calls > 128) throw new BudgetError('The per-step tool-call budget was exhausted.')
          if (part.type === 'tool-call' && part.invalid) {
            const entry = available.find(entry => entry.name === part.toolName)
            const reason = entry && !allowed(entry) ? 'The owner must explicitly allow mixing local files and web access before this tool can run.' : 'Invalid tool request. Check the tool name and input.'
            rejected.set(part.toolCallId, reason)
            emit(state, id, { type: 'tool.denied', callId: part.toolCallId, reason })
          }
          if (part.type === 'text-delta') {
            wireTextUnits += JSON.stringify(part.text).length - 2
            if (text.length + part.text.length > 48000 || wireTextUnits > 60000) throw new BudgetError('The step text budget was exhausted.')
            text += part.text
            state.partialText = text
            state.partialTimer ??= setTimeout(() => {
              state.partialTimer = undefined
              if (!state.controller.signal.aborted && active.get(id) === state) deps.sink.partial(id, step, state.partialText!)
            }, flushMs)
          }
          if (part.type === 'error') throw part.error
        }
        checkpoint(state)
        clearTimeout(state.partialTimer)
        state.partialTimer = undefined
        emit(state, id, { type: 'text', step, text })
        const usage = await result.usage
        const counted = { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 }
        if (!Object.values(counted).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid provider usage.')
        state.store.addUsage(id, counted, now())
        emit(state, id, { type: 'usage', ...counted })
        const response = (await result.responseMessages).map(message => message.role !== 'tool' ? message : { ...message, content: message.content.map(part => part.type === 'tool-result' && rejected.has(part.toolCallId) ? { ...part, output: { type: 'text' as const, value: consume(state, rejected.get(part.toolCallId)!) } } : part) })
        messages = [...messages, ...response]
        state.store.saveCheckpoint({ runId: id, step, messages: JSON.stringify(messages), at: now() })
        if (state.outputExhausted) throw new BudgetError('The tool-output byte budget was exhausted.')
        if (state.store.getRun(id)!.usage.outputTokens >= state.run.budget.maxOutputTokens || await result.finishReason === 'length') throw new BudgetError('The output-token budget was exhausted.')
        const reason = await result.finishReason
        if (reason === 'stop') { status(state, 'succeeded'); return }
        if (reason !== 'tool-calls') throw new Error('Incomplete provider response.')
      }
      throw new BudgetError('The model-step budget was exhausted.')
    } catch (error) {
      if (error instanceof BudgetError) fail(state, { code: 'budget', message: error.message })
      else if (UnsupportedFunctionalityError.isInstance(error) && /tool/i.test(error.functionality)) fail(state, { code: 'model_unsupported', message: 'The selected model does not support agent tools. Choose a tool-capable model.' })
      else fail(state, { code: 'provider', message: PROVIDER_ERROR })
    } finally {
      clearTimeout(state.wallTimer)
      clearTimeout(state.partialTimer)
      if (active.get(id) === state) active.delete(id)
      flush()
    }
  }
  return {
    async handle(command) {
      if (closing) throw new Error('The agent runtime has stopped.')
      switch (command.kind) {
        case 'start': {
          const keys = ['maxSteps', 'maxOutputTokens', 'maxWallMs', 'maxToolOutputBytes'] as const
          if (!command.budget || !keys.every(key => Number.isSafeInteger(command.budget[key]) && command.budget[key] > 0) || command.budget.maxSteps > 10000 || command.budget.maxWallMs > 2147483647) throw new Error('Invalid run budget.')
          const store = command.persistence === 'temporary' ? deps.memoryStore : deps.store
          const artifacts = command.persistence === 'temporary' ? deps.memoryArtifacts : deps.artifacts
          // Mixing can enable a local schema, never mint folder authority. Web
          // starts persist no grants, including when continued after a restart.
          const created = store.createRun({ id: randomUUID(), requestId: command.requestId, goal: command.goal, mode: command.mode, persistence: command.persistence, grants: command.mode === 'local' ? command.grants : [], budget: command.budget, created: now(), ...(command.conversationId ? { conversationId: command.conversationId } : {}) })
          const run = created.run
          if (created.created) {
            const state: Running = { run, store, artifacts, deadline: now() + run.budget.maxWallMs, controller: new AbortController(), task: Promise.resolve(), outputBytes: 0, outputExhausted: false }
            active.set(run.id, state)
            emit(state, run.id, { type: 'run.created', goal: run.goal, mode: run.mode, persistence: run.persistence, budget: run.budget })
            status(state, 'running')
            state.task = execute(state, command)
          }
          return { runId: run.id }
        }
        case 'continue': {
          const binding = find(command.runId)
          const run = binding.store.getRun(command.runId)!
          if (active.has(run.id) || !(run.status === 'interrupted' || (run.status === 'failed' && run.error?.code === 'provider'))) throw new Error('Only an interrupted or provider-failed run can continue.')
          const state: Running = { ...binding, run, deadline: now() + run.budget.maxWallMs, controller: new AbortController(), task: Promise.resolve(), outputBytes: 0, outputExhausted: false }
          active.set(run.id, state)
          status(state, 'running')
          state.task = execute(state, command, binding.store.latestCheckpoint(run.id))
          return { ok: true }
        }
        case 'artifact': {
          const value = await find(command.runId).artifacts.read(command.runId, command.artifactId)
          if (!value) throw new Error('Artifact not found.')
          if (!value.meta.mediaType.startsWith('text/') && value.meta.mediaType !== 'application/json') throw new Error('This artifact cannot be previewed as text.')
          let end = Math.min(value.content.byteLength, 1000000)
          while (end > 0 && end < value.content.byteLength && (value.content[end]! & 0xc0) === 0x80) end--
          return { name: value.meta.name, mediaType: value.meta.mediaType, bytes: value.meta.bytes, text: new TextDecoder().decode(value.content.subarray(0, end)) }
        }
        case 'delete': {
          const binding = find(command.runId)
          const state = active.get(command.runId)
          if (state) cancel(state)
          await binding.artifacts.delete(binding.store.deleteRun(command.runId))
          return { ok: true }
        }
        case 'deleteConversation': {
          for (const state of active.values()) if (state.run.conversationId === command.conversationId) cancel(state)
          await Promise.all([deps.artifacts.delete(deps.store.deleteConversation(command.conversationId)), deps.memoryArtifacts.delete(deps.memoryStore.deleteConversation(command.conversationId))])
          return { ok: true }
        }
        case 'cancelAll': for (const state of active.values()) cancel(state); return { ok: true }
        case 'answer': {
          const state = active.get(command.runId)
          const wait = state?.question
          if (!state || !wait || wait.id !== command.questionId || state.controller.signal.aborted) throw new Error('Question is no longer pending.')
          if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 16000) throw new Error('Invalid answer.')
          state.question = undefined
          emit(state, command.runId, { type: 'answer', questionId: wait.id, text: command.text })
          status(state, 'running')
          wait.resolve(command.text)
          return { ok: true }
        }
        case 'allowMix': {
          const binding = find(command.runId)
          const run = binding.store.getRun(command.runId)!
          if (isTerminal(run.status)) throw new Error('This run is not active.')
          if (!run.mixed) {
            binding.store.setMixed(run.id, now())
            const state = active.get(run.id)
            if (state) state.run.mixed = true
            emit(binding, run.id, { type: 'mode.mixed', allowed: run.mode === 'web' ? 'local' : 'web' })
          }
          return { ok: true }
        }
        case 'approve': {
          const state = active.get(command.runId)
          const wait = state?.approval
          if (!state || !wait || wait.id !== command.approvalId || state.controller.signal.aborted) throw new Error('Approval is no longer pending.')
          state.approval = undefined
          emit(state, command.runId, { type: 'approval.decided', approvalId: wait.id, decision: command.decision })
          status(state, 'running')
          wait.resolve(command.decision)
          return { ok: true }
        }
        case 'cancel': { const state = active.get(command.runId); if (state) cancel(state); else find(command.runId); return { ok: true } }
        case 'events': return { events: find(command.runId).store.events(command.runId, command.afterSeq, command.limit) }
        case 'list': return { runs: [...deps.memoryStore.listRuns(command.limit, command.before), ...deps.store.listRuns(command.limit, command.before)].sort((a, b) => b.updated - a.updated).slice(0, command.limit).map(summary) }
        default: throw new Error('Command is not available.')
      }
    },
    async shutdown() {
      closing = true
      const states = [...active.values()]
      for (const state of states) cancel(state)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.allSettled([...states.map(state => state.task), ...flights]), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })])
      clearTimeout(timer)
      flush()
    },
  }
}
