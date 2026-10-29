import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectionRequest, ConnectionResult } from '../shared/providers'
import { Channels } from '../shared/ipc'

const api = {
  connect: (request: ConnectionRequest): Promise<ConnectionResult> => ipcRenderer.invoke(Channels.connection, request),
}

export type HeyNimboSetupApi = typeof api

contextBridge.exposeInMainWorld('heynimboSetup', api)
