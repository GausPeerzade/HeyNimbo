import { expect, it } from 'vitest'
import { parseAppRequest, parseNotchEvent } from './app-requests'
import { DEFAULT_SETTINGS } from './settings'

it.each([
  null, [], { kind: 'unknown' }, { kind: 'new', extra: true }, { kind: 'snapshot', question: 'extra' },
  { kind: 'open', id: 1 }, { kind: 'open', turnId: [] }, { kind: 'ask', question: 42 }, { kind: 'ask', question: ' ' },
  { kind: 'search', query: {} }, { kind: 'contextMenu', id: '' }, { kind: 'rename', id: 'a' }, { kind: 'rename', id: 'a', title: null },
  { kind: 'settings', category: ['Voice'] }, { kind: 'settings', category: 'Secrets' }, { kind: 'permission', permission: '__proto__' },
  { kind: 'stop', value: true }, { kind: 'replaceKey', key: 'hidden' }, { kind: 'deleteAll', confirmed: true },
  { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, voice: ['marin'] } },
  { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, showMenuBar: 0 } },
  { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, retention: '30' } },
  { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, homeBounds: { x: '0', y: 0, width: 960, height: 680 } } },
])('rejects malformed app IPC before dispatch: %j', value => expect(() => parseAppRequest(value)).toThrow())
it.each([
  { kind: 'hover', over: 'false' }, { kind: 'expanded', expanded: 1 }, { kind: 'hover' },
  { kind: 'home', id: [] }, { kind: 'new', value: false }, { kind: 'stop', value: null },
])('rejects malformed notch IPC: %j', value => expect(() => parseNotchEvent(value)).toThrow())
