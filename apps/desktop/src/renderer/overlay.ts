import type { OverlayCommand } from '../shared/ipc'

const SVG_NS = 'http://www.w3.org/2000/svg'
const stage = document.getElementById('stage') as unknown as SVGSVGElement

function apply(command: OverlayCommand): void {
  stage.replaceChildren()
  if (command.kind === 'clear') return
  const ring = document.createElementNS(SVG_NS, 'circle')
  ring.setAttribute('class', 'ring')
  ring.setAttribute('cx', String(command.ring.x))
  ring.setAttribute('cy', String(command.ring.y))
  ring.setAttribute('r', '28')
  stage.append(ring)
}

window.nimbo.onOverlayCommand(apply)
