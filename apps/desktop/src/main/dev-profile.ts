import { mkdtempSync, rmSync } from 'node:fs'
import { app, Menu } from 'electron'

/** Call before taking an instance lock or opening any persistent store. */
export function isolateDevProfile(name: 'draw-demo' | 'home-preview' | 'model-gallery' | 'model-eval'): () => void {
  if (app.isPackaged) return () => {}
  const directory = mkdtempSync(`/tmp/nimbo-${name}-`)
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  const cleanup = (): void => rmSync(directory, { recursive: true, force: true })
  app.on('will-quit', cleanup)
  return cleanup
}

/** Call before `ready`. A harness launched from a terminal must not take focus,
 *  switch the user's Space or install an app menu. Launching background-only
 *  stops AppKit activating us; app.dock.hide() later makes the demo an
 *  accessory, so its non-activating panels can still show. */
export function launchInBackground(): void {
  if (app.isPackaged) return
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  Menu.setApplicationMenu(null)
}
