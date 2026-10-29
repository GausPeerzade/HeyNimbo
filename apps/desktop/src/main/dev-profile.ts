import { mkdtempSync, rmSync } from 'node:fs'
import { app } from 'electron'

/** Call before taking an instance lock or opening any persistent store. */
export function isolateDevProfile(name: 'draw-demo' | 'home-preview'): () => void {
  if (app.isPackaged) return () => {}
  const directory = mkdtempSync(`/tmp/nimbo-${name}-`)
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  const cleanup = (): void => rmSync(directory, { recursive: true, force: true })
  app.on('will-quit', cleanup)
  return cleanup
}
