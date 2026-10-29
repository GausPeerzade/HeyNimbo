import type { NotchStatus } from '../shared/ipc'

const pill = document.getElementById('pill') as HTMLDivElement
const label = document.getElementById('label') as HTMLSpanElement

function render(status: NotchStatus): void {
  pill.className = 'pill'
  switch (status.kind) {
    case 'idle':
      pill.classList.add('idle')
      label.textContent = ''
      return
    case 'needsPermission':
      pill.classList.add('warning')
      label.textContent = 'Allow Input Monitoring in System Settings'
      return
    case 'active':
      pill.classList.add('active')
      label.textContent = status.label
  }
}

window.nimbo.onNotchStatus(render)
