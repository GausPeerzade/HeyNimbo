import { join } from 'node:path'

/** Shared layout only: neither Electron nor storage is initialized on import. */
export function agentPaths(dataDir: string) {
  return { db: join(dataDir, 'agent.sqlite'), artifacts: join(dataDir, 'agent-artifacts') }
}
