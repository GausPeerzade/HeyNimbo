import type { HistoryTurn } from '../shared/app'
import { element } from './app-dom'
import { sceneThumbnail } from './scene-thumbnail'

interface TurnNodes {
  section: HTMLElement
  question: HTMLElement
  meta: HTMLElement
  answer: HTMLElement
  state: HTMLElement
  drawing?: HTMLElement
  drawingBeats: number
  steps?: HTMLElement
  stepsKey: string
}
const time = (date: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
function setText(node: HTMLElement, text: string): void { if (node.textContent !== text) node.textContent = text }

/** Stable message nodes preserve selection and old drawing geometry while streaming. */
export class TurnTranscript {
  private readonly nodes = new Map<string, TurnNodes>()
  constructor(private readonly container: HTMLElement) {}
  clear(): void { for (const view of this.nodes.values()) view.section.remove(); this.nodes.clear() }
  render(turns: HistoryTurn[], activeId: string | null): void {
    const live = new Set(turns.map(turn => turn.id))
    for (const [id, view] of this.nodes) if (!live.has(id)) { view.section.remove(); this.nodes.delete(id) }
    for (const [index, turn] of turns.entries()) {
      let view = this.nodes.get(turn.id)
      if (!view) {
        const section = element('section', 'turn'); section.id = `turn-${turn.id}`
        view = { section, question: element('h2', 'question'), meta: element('p', 'turn-meta'), answer: element('p', 'answer'), state: element('p', 'turn-state'), drawingBeats: -1, stepsKey: '' }
        section.append(view.question, view.meta, view.answer, view.state)
        this.nodes.set(turn.id, view)
      }
      const active = activeId === turn.id
      setText(view.question, turn.question)
      setText(view.meta, `${turn.mode === 'voice' ? 'Spoken' : 'Typed'} at ${time(turn.created)}${turn.screenContextUsed ? ', with your screen' : ''}`)
      setText(view.answer, turn.answer || (active ? 'Thinking…' : 'No answer'))
      setText(view.state, active ? '' : turn.state === 'interrupted' ? 'Stopped' : turn.state === 'error' ? turn.error ?? 'The answer failed. Check your connection and try again.' : '')
      view.state.className = `turn-state ${turn.state}`
      view.state.hidden = active || turn.state === 'complete'
      // Scene beats are append-only. Answer deltas don't rebuild existing thumbnails.
      if (view.drawingBeats !== turn.scene.beats.length) {
        view.drawing?.remove(); view.drawing = undefined
        const svg = sceneThumbnail(turn.scene)
        if (svg) { view.drawing = element('figure', 'drawing'); view.drawing.append(svg); view.section.append(view.drawing) }
        view.drawingBeats = turn.scene.beats.length
      }
      // What the agent did (searches, reads, edits, commands) sits between the question and the answer.
      const steps = turn.scene.steps ?? [], stepsKey = JSON.stringify(steps)
      if (view.stepsKey !== stepsKey) {
        view.steps?.remove(); view.steps = undefined
        if (steps.length) {
          view.steps = element('ul', 'turn-steps')
          view.steps.append(...steps.map(step => element('li', step.state, step.state === 'failed' || step.state === 'stopped' ? `${step.label} · ${step.state}` : step.label)))
          view.section.insertBefore(view.steps, view.answer)
        }
        view.stepsKey = stepsKey
      }
      if (this.container.children[index] !== view.section) this.container.insertBefore(view.section, this.container.children[index] ?? null)
    }
  }
}
