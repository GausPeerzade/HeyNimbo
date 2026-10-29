/** A host-owned policy error, never constructed from raw provider messages. */
export class PlanAccessError extends Error {
  constructor() { super('Do mode needs an API key or a local model; ChatGPT plan access is used for Explain only.') }
}
