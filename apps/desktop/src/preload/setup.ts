import { contextBridge, ipcRenderer } from 'electron'
import { Channels, type SaveKeyResult } from '../shared/ipc'

const api = {
  saveOpenAIKey: (key: string): Promise<SaveKeyResult> => ipcRenderer.invoke(Channels.saveOpenAIKey, key),
}

export type NimboSetupApi = typeof api

contextBridge.exposeInMainWorld('nimboSetup', api)
