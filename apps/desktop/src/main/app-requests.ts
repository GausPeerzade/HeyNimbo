import type { AppRequest, NotchEvent } from '../shared/app'
import { parseConnectionRequest } from './provider-settings'
import { parseSettings } from './settings'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.')
  return value as Record<string, unknown>
}
function shape(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some(key => key !== 'kind' && !keys.includes(key))) throw new Error('Unknown request field.')
}
function text(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) throw new Error('Invalid request text.')
  return value
}
function optionalID(value: unknown): string | undefined { return value === undefined ? undefined : text(value, 200) }

export function parseAppRequest(value: unknown): AppRequest {
  const input = record(value)
  switch (input.kind) {
    case 'snapshot': case 'new': case 'stop': case 'deleteAll': case 'replaceKey':
      shape(input, []); return { kind: input.kind }
    case 'open':
      shape(input, ['id', 'turnId']); return { kind: 'open', id: optionalID(input.id), turnId: optionalID(input.turnId) }
    case 'ask':
      shape(input, ['question']); return { kind: 'ask', question: text(input.question, 16000) }
    case 'search':
      shape(input, ['query']); return { kind: 'search', query: text(input.query, 500, false) }
    case 'contextMenu':
      shape(input, ['id']); return { kind: 'contextMenu', id: text(input.id, 200) }
    case 'rename':
      shape(input, ['id', 'title']); return { kind: 'rename', id: text(input.id, 200), title: text(input.title, 100, false) }
    case 'settings':
      shape(input, ['category'])
      if (input.category !== undefined && (typeof input.category !== 'string' || !['General', 'Voice', 'History & privacy', 'Connection', 'About'].includes(input.category))) throw new Error('Invalid settings category.')
      return { kind: 'settings', category: input.category as string | undefined }
    case 'updateSettings':
      shape(input, ['settings']); return { kind: 'updateSettings', settings: parseSettings(input.settings, true) }
    case 'connection':
      shape(input, ['request']); return { kind: 'connection', request: parseConnectionRequest(input.request) }
    case 'permission':
      shape(input, ['permission'])
      if (input.permission !== 'microphone' && input.permission !== 'screen' && input.permission !== 'input') throw new Error('Invalid permission.')
      return { kind: 'permission', permission: input.permission }
    default: throw new Error('Unknown request.')
  }
}

export function parseNotchEvent(value: unknown): NotchEvent {
  const input = record(value)
  switch (input.kind) {
    case 'hover':
      shape(input, ['over']); if (typeof input.over !== 'boolean') throw new Error('Invalid hover state.')
      return { kind: 'hover', over: input.over }
    case 'expanded':
      shape(input, ['expanded']); if (typeof input.expanded !== 'boolean') throw new Error('Invalid peek state.')
      return { kind: 'expanded', expanded: input.expanded }
    case 'home':
      shape(input, ['id']); return { kind: 'home', id: optionalID(input.id) }
    case 'new': case 'stop': shape(input, []); return { kind: input.kind }
    default: throw new Error('Unknown notch event.')
  }
}
