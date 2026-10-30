import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { answerInstructions, answerMessages, streamProviderAnswer, type AnswerConnection, type AnswerOptions } from './answer-provider'
const key = 'synthetic-test-credential'
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in tests') })) })
afterEach(() => { vi.unstubAllGlobals() })
function options(provider: AnswerConnection['provider'] = 'openai', vision = true): AnswerOptions {
  return { connection: { provider, model: provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-6.1-terra', effort: 'low', vision, baseURL: 'http://127.0.0.1:1234/v1', credential: async () => key }, instructions: 'Draw carefully.', question: 'What is this?', history: [{ question: 'Before', answer: 'Earlier answer' }], screenshot: { jpeg: Buffer.from('fake-pixels'), width: 800, height: 600, cursor: { x: 20, y: 30 } }, signal: new AbortController().signal }
}
function response(events: unknown[], named = false): Response {
  return new Response(events.map(event => `${named ? `event: ${(event as { type: string }).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}
async function collect(input: AnswerOptions, transport: typeof fetch): Promise<string> { let text = ''; for await (const delta of streamProviderAnswer(input, transport)) text += delta; return text }
function openaiEvents(terminal: 'response.completed' | 'response.incomplete' = 'response.completed'): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_mock', created_at: 100, model: 'gpt-6.1-terra' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_mock', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0, delta: '@circle 20 30 10\nHere.' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_mock', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '@circle 20 30 10\nHere.', annotations: [] }] } },
    { type: terminal, response: { id: 'resp_mock', status: terminal === 'response.completed' ? 'completed' : 'incomplete', incomplete_details: terminal === 'response.incomplete' ? { reason: 'max_output_tokens' } : null, usage: { input_tokens: 5, output_tokens: 4 } } },
  ]
}
it.each((['openai', 'chatgpt'] as const).flatMap(provider => ([undefined, 'low', 'medium', 'high'] as const).map(effort => ({ provider, effort }))))('normalizes $provider Responses SSE with thinking $effort, image/history and the exact plan-compatible body', async ({ provider, effort }) => {
  const transport = vi.fn<typeof fetch>(async () => response(openaiEvents()))
  const input = options(provider); input.connection.effort = effort
  expect(await collect(input, transport)).toBe('@circle 20 30 10\nHere.')
  const [url, init] = transport.mock.calls[0]!, body = JSON.parse(String(init?.body))
  expect(String(url)).toBe('https://api.openai.com/v1/responses')
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
  expect(body).toMatchObject({ model: 'gpt-6.1-terra', store: false, stream: true })
  expect(body.reasoning?.effort).toBe(effort)
  expect(body.input[0]).toMatchObject({ role: 'developer', content: 'Draw carefully.' })
  expect(body.input.at(-1).content).toContainEqual({ type: 'input_image', image_url: `data:image/jpeg;base64,${Buffer.from('fake-pixels').toString('base64')}` })
  expect(JSON.stringify(body.input)).toContain('Earlier answer')
  for (const field of ['max_output_tokens', 'temperature', 'previous_response_id', 'metadata', 'prompt', 'truncation']) expect(body).not.toHaveProperty(field)
})
it.each([undefined, 'low', 'medium', 'high'] as const)('normalizes Anthropic deltas with thinking %s, screenshots and system cache control', async effort => {
  const transport = vi.fn<typeof fetch>(async () => response([
    { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A Claude answer.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ], true))
  const input = options('anthropic'); input.connection.effort = effort
  expect(await collect(input, transport)).toBe('A Claude answer.')
  const [url, init] = transport.mock.calls[0]!, body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers)
  expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
  expect(headers.get('x-api-key')).toBe(key); expect(headers.get('anthropic-version')).toBe('2023-06-01')
  expect(body.system).toEqual([{ type: 'text', text: 'Draw carefully.', cache_control: { type: 'ephemeral' } }])
  expect(body.output_config?.effort).toBe(effort)
  expect(body.messages.at(-1).content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('fake-pixels').toString('base64') } })
})
it('normalizes OpenAI-compatible chat streaming and keeps text-only prompts free of images and drawing permissions', async () => {
  const transport = vi.fn<typeof fetch>(async () => response([
    { id: 'chat_mock', object: 'chat.completion.chunk', created: 100, model: 'local', choices: [{ index: 0, delta: { content: 'Local answer.' }, finish_reason: null }] },
    { id: 'chat_mock', object: 'chat.completion.chunk', created: 100, model: 'local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]))
  expect(await collect(options('compatible', false), transport)).toBe('Local answer.')
  const [url, init] = transport.mock.calls[0]!, body = JSON.parse(String(init?.body))
  expect(String(url)).toBe('http://127.0.0.1:1234/v1/chat/completions')
  expect(JSON.stringify(body)).not.toContain(Buffer.from('fake-pixels').toString('base64'))
  expect(body.messages[0].content).toContain('Do not refer to unseen screen contents or emit any @ drawing commands.')
  expect(body.messages.at(-1).content).toContain('No screenshot')
})
it('keeps drawing available on a screen-sized canvas when a vision model gets no screenshot, without inviting screen claims', () => {
  const input = { ...options(), screenshot: undefined, canvas: { width: 1440, height: 900 } }
  const system = String(answerInstructions(input).content)
  expect(system).toContain('1440x900')
  expect(system).not.toContain('emit any @ drawing commands')
  expect(system).toContain('Do not describe or point at anything on the screen')
  const last = answerMessages(input).at(-1)!
  expect(typeof last.content === 'string' && last.content).toContain('No screenshot was available')
  // Text-only models keep the strict text-only contract even if a canvas is offered.
  expect(String(answerInstructions({ ...input, connection: { ...input.connection, vision: false } }).content)).toContain('emit any @ drawing commands')
})
it.each(['interrupted', 'incomplete', 'failed', 'error'] as const)('refuses %s streams and never leaks SDK request bodies or credentials through errors', async kind => {
  const events = kind === 'interrupted' ? openaiEvents().slice(0, -1) : kind === 'incomplete' ? openaiEvents('response.incomplete') : [{ type: kind === 'failed' ? 'response.failed' : 'error', response: { error: { code: 'synthetic', message: key } }, code: 'synthetic', message: key }]
  const transport = vi.fn<typeof fetch>(async () => response(events))
  await expect(collect(options(), transport)).rejects.toThrow('could not complete')
  try { await collect(options(), transport) } catch (error) { expect(String(error)).not.toContain(key); expect(String(error)).not.toContain('fake-pixels') }
})
it('blocks every screenshot part for a model with no image capability', () => {
  const messages = answerMessages(options('deepseek', false))
  expect(JSON.stringify(messages)).not.toContain('fake-pixels')
  expect(answerInstructions(options('deepseek', false)).content).toContain('text only')
})

it('requires the Anthropic message_stop event even after a delta claims end_turn', async () => {
  const transport = vi.fn<typeof fetch>(async () => response([
    { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  ], true))
  await expect(collect(options('anthropic'), transport)).rejects.toThrow('could not complete')
})
it.each(['anthropic', 'compatible'] as const)('rejects %s error events rather than treating them as empty answers', async provider => {
  const transport = vi.fn<typeof fetch>(async () => provider === 'anthropic' ? response([{ type: 'error', error: { type: 'overloaded_error', message: key } }], true) : response([{ error: { message: key, type: 'server_error' } }]))
  await expect(collect(options(provider), transport)).rejects.toThrow('could not complete')
})
it.each(['subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded'] as const)('makes %s actionable without logging tokens, response bodies or screenshots', async code => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const transport = vi.fn<typeof fetch>(async () => response([...openaiEvents().slice(0, -1), { type: 'response.failed', sequence_number: 5, response: { error: { code, message: key } } }]))
  await expect(collect(options('chatgpt'), transport)).rejects.toThrow(code.includes('eligible') ? 'not eligible' : 'Manage usage')
  expect(log).not.toHaveBeenCalled(); log.mockRestore()
})
it.each(['deepseek', 'openrouter'] as const)('uses the official %s SDK transport with bearer auth and chat-completion deltas', async provider => {
  const transport = vi.fn<typeof fetch>(async () => response([
    { id: 'chat_mock', object: 'chat.completion.chunk', created: 100, model: 'mock-model', choices: [{ index: 0, delta: { content: 'Answer.' }, finish_reason: null }] },
    { id: 'chat_mock', object: 'chat.completion.chunk', created: 100, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]))
  expect(await collect(options(provider), transport)).toBe('Answer.')
  const [url, init] = transport.mock.calls[0]!, body = JSON.parse(String(init?.body))
  expect(String(url)).toBe(provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions')
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
  expect(JSON.stringify(body.messages.at(-1))).toContain('data:image/jpeg;base64,')
  if (provider === 'deepseek') expect(body.thinking).toEqual({ type: 'disabled' })
})
it('uses Google header authentication and the Gemini streaming image-input shape', async () => {
  const transport = vi.fn<typeof fetch>(async () => response([{ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini answer.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } }]))
  const input = options('google'); input.connection.model = 'gemini-3.8-flash'
  expect(await collect(input, transport)).toBe('Gemini answer.')
  const [url, init] = transport.mock.calls[0]!, body = JSON.parse(String(init?.body))
  expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse')
  expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(key)
  expect(body.contents.at(-1).parts).toContainEqual({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('fake-pixels').toString('base64') } })
})
it('requires response.completed even if an incomplete event omits its reason', async () => {
  const events = openaiEvents('response.incomplete') as Array<{ response?: { incomplete_details?: unknown } }>
  events.at(-1)!.response!.incomplete_details = null
  const transport = vi.fn<typeof fetch>(async () => response(events))
  await expect(collect(options('chatgpt'), transport)).rejects.toThrow('could not complete')
})

it('sanitizes credential/discovery errors before they can reach history or logs', async () => {
  const input = options(); input.connection.credential = async () => { throw new Error(`Malformed response echoed ${key}`) }
  await expect(collect(input, vi.fn())).rejects.toThrow('could not complete')
  try { await collect(input, vi.fn()) } catch (error) { expect(String(error)).not.toContain(key) }
})
