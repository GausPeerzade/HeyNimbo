/** Development-only rAF sampling, enabled by the unpackaged main process. */
export class FrameTrace {
  enabled = false
  private until = 0
  private running = false

  activeUntil(until: number): void {
    if (!this.enabled) return
    this.until = Math.max(this.until, until)
    if (this.running) return
    this.running = true
    let previous: number | undefined
    const deltas: number[] = []
    const tick = (now: number): void => {
      if (previous !== undefined) deltas.push(now - previous)
      previous = now
      if (now < this.until) requestAnimationFrame(tick)
      else {
        this.running = false
        window.heynimbo.sendOverlayEvent({ kind: 'frameTrace', deltas })
      }
    }
    requestAnimationFrame(tick)
  }
}
