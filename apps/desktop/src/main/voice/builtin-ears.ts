import { SpeechSession } from '@heynimbo/native'

/** One on-device task per hold, fed only by the existing audio window. */
export class BuiltInEars {
  private session: SpeechSession | undefined
  private failure: Error | undefined
  private generation = 0
  private cancelled: (() => void) | undefined

  constructor(private readonly locale?: string) {}

  warm(): void {}

  begin(): void {
    this.cancel()
    try { this.session = new SpeechSession(this.locale) }
    catch (error) { this.failure = error instanceof Error ? error : new Error('Built-in listening unavailable.') }
  }

  append(pcm: Uint8Array): void {
    if (!this.session || this.failure) return
    try { this.session.append(Buffer.from(pcm)) }
    catch (error) { this.failure = error instanceof Error ? error : new Error('Built-in listening failed.') }
  }

  async finish(): Promise<string> {
    const session = this.session, generation = this.generation
    if (this.failure) { const error = this.failure; this.cancel(); throw error }
    if (!session) return ''
    try {
      const cancelled = new Promise<string>(resolve => { this.cancelled = () => resolve('') })
      const result = await Promise.race([session.finish(), cancelled])
      return generation === this.generation ? result.trim() : ''
    } finally {
      if (generation === this.generation) { this.session = undefined; this.cancelled = undefined; session.cancel() }
    }
  }

  cancel(): void {
    this.generation++
    this.cancelled?.(); this.cancelled = undefined
    this.session?.cancel(); this.session = undefined
    this.failure = undefined
  }

  close(): void { this.cancel() }
}
