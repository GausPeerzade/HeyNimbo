import { describe, expect, it } from 'vitest'
import { defaultConnectionSettings, selectedModel, type ConnectionSettings, type ModelChoice } from '../shared/providers'
import { parseConnectionSettings } from './provider-settings'

function settings(provider: ConnectionSettings['provider'], choice: ModelChoice): ConnectionSettings {
  const base = defaultConnectionSettings()
  return { ...base, provider, models: { ...base.models, [provider]: choice } }
}

describe('answer speed (OpenAI service tier)', () => {
  it('saves Ultrafast for GPT-6.1 Sol and sends it with the selected model', () => {
    const saved = parseConnectionSettings(settings('openai', { model: 'gpt-6.1-sol', effort: 'low', speed: 'ultrafast' }))
    expect(saved.models.openai).toEqual({ model: 'gpt-6.1-sol', effort: 'low', speed: 'ultrafast' })
    expect(selectedModel(saved)).toMatchObject({ model: 'gpt-6.1-sol', effort: 'low', speed: 'ultrafast' })
  })

  it('refuses a speed the model or connection does not offer, so nothing is billed at a tier that was never chosen', () => {
    // Ultrafast exists only for GPT-6.1 Sol and GPT-6 Astra; ChatGPT plan access and other providers have no tiers.
    expect(() => parseConnectionSettings(settings('openai', { model: 'gpt-6.1-terra', speed: 'ultrafast' }))).toThrow('Invalid speed.')
    expect(() => parseConnectionSettings(settings('chatgpt', { model: 'gpt-6.1-sol', speed: 'fast' }))).toThrow('Invalid speed.')
    expect(() => parseConnectionSettings(settings('anthropic', { model: 'claude-sonnet-5-5', speed: 'fast' }))).toThrow('Invalid speed.')
    expect(() => parseConnectionSettings(settings('openai', { model: 'gpt-6.1-sol', speed: 'warp' as never }))).toThrow('Invalid speed.')
  })

  it('sends no tier for Standard, and drops a saved speed once the model no longer offers it', () => {
    expect(selectedModel(settings('openai', { model: 'gpt-6.1-sol', speed: 'standard' }))).not.toHaveProperty('speed')
    expect(selectedModel(settings('openai', { model: 'gpt-6.1-terra', speed: 'ultrafast' }))).not.toHaveProperty('speed')
    expect(selectedModel(settings('openai', { model: 'gpt-6.1-terra', speed: 'fast' }))).toMatchObject({ speed: 'fast' })
  })
})
