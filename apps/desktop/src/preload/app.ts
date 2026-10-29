import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ConnectionResult } from '../shared/providers'
import { AppChannels, type AppRequest, type AppSnapshot, type SearchHit } from '../shared/app'
const api = {
  request: (request: AppRequest): Promise<ConnectionResult | AppSnapshot | SearchHit[] | { accepted: true } | void> => ipcRenderer.invoke(AppChannels.request, request),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot)
    ipcRenderer.on(AppChannels.snapshot, handler)
    return () => ipcRenderer.removeListener(AppChannels.snapshot, handler)
  },
  onNavigate: (listener: (navigation: { turnId?: string; renameId?: string; category?: string; focusSearch?: boolean }) => void) => {
    ipcRenderer.on(AppChannels.navigate, (_event, navigation) => listener(navigation))
  },
}
export type HeyNimboAppApi = typeof api
contextBridge.exposeInMainWorld('heynimboApp', api)
