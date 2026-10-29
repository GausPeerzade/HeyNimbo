import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channels, type VoiceCommand, type VoiceEvent } from '../shared/ipc'

const api = {
  onCommand: (listener: (command: VoiceCommand) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, command: VoiceCommand): void => listener(command)
    ipcRenderer.on(Channels.voiceCommand, handler)
    return () => ipcRenderer.removeListener(Channels.voiceCommand, handler)
  },
  send: (event: VoiceEvent): void => ipcRenderer.send(Channels.voiceEvent, event),
}

export type NimboVoiceApi = typeof api

contextBridge.exposeInMainWorld('nimboVoice', api)
