import { app } from 'electron'

/** A development switch: on only when explicitly `=1`, never in a packaged app. */
export function devFlag(name: string): boolean {
  return !app.isPackaged && process.env[name] === '1'
}

/** A development setting such as a directory; always undefined in a packaged app. */
export function devSetting(name: string): string | undefined {
  return app.isPackaged ? undefined : process.env[name] || undefined
}
