import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channels, type NotchStatus, type OverlayCommand } from '../shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  onNotchStatus: (listener: (status: NotchStatus) => void) => subscribe(Channels.notchStatus, listener),
  onOverlayCommand: (listener: (command: OverlayCommand) => void) => subscribe(Channels.overlay, listener),
}

export type NimboApi = typeof api

contextBridge.exposeInMainWorld('nimbo', api)
