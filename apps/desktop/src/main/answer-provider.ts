import { streamText, type LanguageModel, type LanguageModelUsage, type SystemModelMessage, type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { Effort, ProviderId } from '../shared/providers'
import { noRedirectFetch } from './provider-settings'
import type { Exchange, Screenshot } from './voice/brain'

export interface AnswerConnection {
  provider: ProviderId; model: string; effort?: Effort; vision: boolean; baseURL?: string
  credential(): Promise<string>
}
export interface AnswerOptions {
  connection: AnswerConnection; instructions: string; question: string; screenshot?: Screenshot; history: readonly Exchange[]; signal: AbortSignal
  /** Token counts as the provider reports them, once the answer finishes. */
  onUsage?: (usage: LanguageModelUsage) => void
}
export function answerInstructions(options: AnswerOptions): SystemModelMessage {
  return { role: 'system', content: options.instructions + (options.connection.vision && options.screenshot ? '' : '\nNo screenshot is available. Answer from text only. Do not refer to unseen screen contents or emit any @ drawing commands.'), providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
}
export function answerMessages(options: AnswerOptions): ModelMessage[] {
  const screenshot = options.connection.vision ? options.screenshot : undefined
  const pointer = screenshot?.cursor ? `The mouse pointer is at x=${Math.round(screenshot.cursor.x)}, y=${Math.round(screenshot.cursor.y)} in this ${screenshot.width}x${screenshot.height} screenshot.` : 'The mouse pointer is on another display.'
  return [
    ...options.history.flatMap<ModelMessage>(({ question, answer }) => [{ role: 'user', content: question }, { role: 'assistant', content: answer }]),
    { role: 'user', content: screenshot ? [{ type: 'text', text: `${options.question}\n\n(${pointer})` }, { type: 'file', data: screenshot.jpeg, mediaType: 'image/jpeg' }] : `${options.question}\n\n(No screenshot was available.)` },
  ]
}
export function sdkModel(connection: AnswerConnection, key: string, transport = noRedirectFetch): LanguageModel {
  switch (connection.provider) {
    case 'openai': case 'chatgpt': return createOpenAI({ apiKey: key, fetch: transport }).responses(connection.model)
    case 'anthropic': return createAnthropic({ apiKey: key, fetch: transport })(connection.model)
    case 'google': return createGoogle({ apiKey: key, fetch: transport })(connection.model)
    case 'deepseek': return createDeepSeek({ apiKey: key, fetch: transport })(connection.model)
    case 'openrouter': return createOpenRouter({ apiKey: key, fetch: transport }).chat(connection.model)
    case 'compatible': return createOpenAICompatible({ name: 'compatible', baseURL: connection.baseURL!, apiKey: key || undefined, fetch: transport }).chatModel(connection.model)
  }
}
/** Only this adapter normalizes the SDK stream into the turn pipeline's text deltas. */
export async function* streamProviderAnswer(options: AnswerOptions, transport = noRedirectFetch): AsyncGenerator<string> {
  const { provider, effort } = options.connection
  try {
    const key = await options.connection.credential()
    if (options.signal.aborted) return
    const result = streamText({
      model: sdkModel(options.connection, key, transport), instructions: answerInstructions(options), onError: () => {}, messages: answerMessages(options), abortSignal: options.signal,
      maxRetries: 0, streamRetries: 0, includeRawChunks: true,
      ...(['chatgpt', 'openai'].includes(provider) ? {} : { maxOutputTokens: 8192 }),
      providerOptions: {
        openai: { store: false, systemMessageMode: 'developer', ...(effort ? { reasoningEffort: effort } : {}) },
        anthropic: { ...(effort ? { effort } : {}) },
        deepseek: { thinking: { type: 'disabled' } },
      },
    })
    let completed = false
    let terminalEvent = !['chatgpt', 'openai', 'anthropic'].includes(provider)
    for await (const part of result.fullStream) {
      if (part.type === 'raw') {
        const type = (part.rawValue as { type?: string })?.type
        if ((['chatgpt', 'openai'].includes(provider) && type === 'response.completed') || (provider === 'anthropic' && type === 'message_stop')) terminalEvent = true
      } else if (part.type === 'text-delta') yield part.text
      else if (part.type === 'error') throw part.error
      else if (part.type === 'abort') throw new Error('The answer was interrupted.')
      else if (part.type === 'finish') {
        options.onUsage?.(part.totalUsage)
        if (part.finishReason !== 'stop') throw new Error('The answer stream ended without a completed response.')
        completed = true
      }
    }
    if (!completed || !terminalEvent) throw new Error('The answer stream ended before completion.')
  } catch (error) {
    // SDK errors can embed request bodies, headers and transport diagnostics.
    // Only fixed, actionable messages cross into history, IPC or logs.
    const credentialMessages = new Set([
      'Sign in with ChatGPT again; this grant has expired or been disconnected.',
      'ChatGPT could not renew this grant. Sign in again.',
      'ChatGPT authorization is temporarily unavailable. Try again later.',
      'ChatGPT plan usage is not enabled. Enable it with Continue with ChatGPT or add an API key; an eligible Plus or Pro plan is required.',
      'The selected model is not available for this connection. Choose one in Settings → Connection.',
      'Add a key for the selected answer provider in Settings → Connection.',
    ])
    if (error instanceof Error && credentialMessages.has(error.message)) throw new Error(error.message)
    const details = error as { code?: string; data?: { error?: { code?: string }; response?: { error?: { code?: string } } } }
    const code = details?.code ?? details?.data?.error?.code ?? details?.data?.response?.error?.code
    if (code === 'subscription_sharing_user_not_eligible') throw new Error('This ChatGPT account or workspace is not eligible for plan usage. Choose another connection.')
    if (code === 'subscription_sharing_usage_limit_exceeded') throw new Error('ChatGPT plan usage limit reached. Open Manage usage in Settings → Connection.')
    if (options.signal.aborted) throw new Error('The answer was interrupted.')
    throw new Error('The answer provider could not complete this request. Check the connection, selected model and usage limits in Settings.')
  }
}
