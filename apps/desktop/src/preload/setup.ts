import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectionRequest, ConnectionResult } from '../shared/providers'
import { Channels, type SaveKeyResult } from '../shared/ipc'

const api = {
  connect: (request: ConnectionRequest): Promise<ConnectionResult> => ipcRenderer.invoke(Channels.connection, request),
  saveOpenAIKey: (key: string): Promise<SaveKeyResult> => ipcRenderer.invoke(Channels.saveOpenAIKey, key),
}

export type NimboSetupApi = typeof api

contextBridge.exposeInMainWorld('nimboSetup', api)
