import type { AgentRuntime } from '../contracts'
import type { HostInit } from './serve'

// Replaced by the integrator once the runtime, stores and tool modules land.
export async function composeRuntime(_init: HostInit): Promise<AgentRuntime> {
  throw new Error('Agent runtime not available yet.')
}
