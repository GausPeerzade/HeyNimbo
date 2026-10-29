import { sdkModel } from '../../main/answer-provider'
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai'
import { PROVIDERS, type ProviderId } from '../../shared/providers'
import { FileArtifactStore, MemoryArtifactStore } from '../artifacts'
import type { AgentRuntime, Clock, ModelFactory, Resolver } from '../contracts'
import { agentPaths } from '../paths'
import { PlanAccessError } from '../model-policy'
import { createAgentRuntime } from '../runtime'
import { MemoryAgentStore, SqliteAgentStore } from '../store'
import { artifactTools, localTools } from '../tools/files'
import { webTools } from '../tools/web'
import type { HostInit } from './serve'

interface TestOverrides { models?: ModelFactory; resolver?: Resolver; allowLoopbackForTests?: boolean; clock?: Clock }
const productionModels: ModelFactory = async (selection, credentials) => {
  if (!PROVIDERS.includes(selection.provider as ProviderId)) throw new Error('Unsupported model provider.')
  const credential = () => credentials(selection.provider, { baseURL: selection.baseURL })
  return sdkModel({ ...selection, provider: selection.provider as ProviderId, vision: false, credential }, await credential())
}

export async function composeRuntime(init: HostInit, overrides: TestOverrides = {}): Promise<AgentRuntime> {
  const paths = agentPaths(init.dataDir)
  const store = new SqliteAgentStore(paths.db)
  const memoryStore = new MemoryAgentStore()
  const artifacts = new FileArtifactStore(paths.artifacts)
  try {
    const now = overrides.clock?.now() ?? Date.now()
    await artifacts.sweepTemporary(now)
    store.interruptUnfinished(now)
  } catch (error) { store.close(); memoryStore.close(); throw error }
  const runtime = createAgentRuntime({
    store, memoryStore, artifacts, memoryArtifacts: new MemoryArtifactStore(),
    models: async (selection, credentials) => {
      if (selection.provider === 'chatgpt') throw new PlanAccessError()
      const model = await (overrides.models ?? productionModels)(selection, credentials)
      if (typeof model === 'string') throw new Error('An explicit model connection is required.')
      return wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings: { providerOptions: {
        openai: { store: false, include: ['reasoning.encrypted_content'], ...(selection.effort ? { reasoningEffort: selection.effort } : {}) },
        anthropic: { ...(selection.effort ? { effort: selection.effort } : {}) },
      } } }) })
    },
    tools: options => [...localTools(), ...artifactTools(), ...webTools({ ...options, resolver: overrides.resolver, allowLoopbackForTests: overrides.allowLoopbackForTests })],
    credentials: init.credentials, sink: init.sink, clock: overrides.clock,
  })
  let stopped: Promise<void> | undefined
  return {
    handle: command => runtime.handle(command),
    shutdown: () => stopped ??= runtime.shutdown().finally(() => { store.close(); memoryStore.close() }),
  }
}
