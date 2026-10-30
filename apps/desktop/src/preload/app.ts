import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionResult } from '../shared/providers'
import { AppChannels, type AppRequest, type AppSnapshot, type SearchHit } from '../shared/app'
import { AgentChannels, type AgentApi, type AgentPush } from '../shared/agent-protocol'
const agent: AgentApi = {
  request: request => ipcRenderer.invoke(AgentChannels.request, request),
  onPush: listener => {
    const handler = (_event: IpcRendererEvent, push: AgentPush): void => listener(push)
    ipcRenderer.on(AgentChannels.push, handler)
    return () => { ipcRenderer.removeListener(AgentChannels.push, handler) }
  },
}
const api = {
  agent,
  request: (request: AppRequest): Promise<ConnectionResult | AppSnapshot | SearchHit[] | { accepted: true } | void> => ipcRenderer.invoke(AppChannels.request, request),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot)
    ipcRenderer.on(AppChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(AppChannels.snapshot, handler)
  },
  onNavigate: (listener: (navigation: { turnId?: string; renameId?: string; category?: string; focusSearch?: boolean; runId?: string }) => void) => {
    ipcRenderer.on(AppChannels.navigate, (_event, navigation) => listener(navigation))
  },
}
export type HeyNimboAppApi = typeof api
contextBridge.exposeInMainWorld('heynimboApp', api)
