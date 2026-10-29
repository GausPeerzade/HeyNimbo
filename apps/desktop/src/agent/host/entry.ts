import { serveHost } from './serve'

// Electron's utility-process port delivers { data }, unlike its parent's child.
// Keep this adapter Electron-free so the runtime remains usable headlessly.
interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: { data: unknown }) => void): unknown
}
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) process.exit(1)
const host = serveHost({
  postMessage: message => parent.postMessage(message),
  on: (_event, listener) => parent.on('message', event => listener(event.data)),
}, async init => {
  try {
    const { composeRuntime } = await import('./compose')
    return await composeRuntime(init)
  } catch { process.exit(1) }
})
process.once('SIGTERM', () => { void host.dispose().then(() => process.exit(0), () => process.exit(1)) })
