import type { NotchStatus } from '../shared/ipc'
import type { AppSnapshot } from '../shared/app'
import logo from '../../build/brand/logo.png?url'
import darkLogo from '../../build/brand/logo-dark.png?url'

const surface = document.getElementById('surface')!
const pill = document.getElementById('pill') as HTMLButtonElement
const peek = document.getElementById('peek')!
const label = document.getElementById('label')!
const mark = document.getElementById('mark') as HTMLImageElement
let currentStatus = 'Ready when you are'
let enterTimer: ReturnType<typeof setTimeout>, leaveTimer: ReturnType<typeof setTimeout>, suppressed = false
const theme = matchMedia('(prefers-color-scheme: dark)')
const updateMark = () => { mark.src = theme.matches ? darkLogo : logo }
updateMark(); theme.addEventListener('change', updateMark)
const motionTokens = getComputedStyle(document.documentElement)
const hoverDwell = Number(motionTokens.getPropertyValue('--hover-dwell'))
const leaveGrace = Number(motionTokens.getPropertyValue('--leave-grace'))
function setPeek(expanded: boolean): void {
  // CSS retains the exiting surface; inert prevents stale controls during exit.
  peek.inert = !expanded
  peek.hidden = !expanded
  window.heynimbo.sendNotchEvent({ kind: 'expanded', expanded })
}
function dismiss(): void {
  clearTimeout(enterTimer); clearTimeout(leaveTimer); setPeek(false); suppressed = over
  window.heynimbo.sendNotchEvent({ kind: 'hover', over: false })
}
function render(status: NotchStatus): void {
  pill.className = `pill ${status.kind}`
  label.textContent = status.kind === 'idle' ? 'HeyNimbo' : status.kind === 'active' ? status.label : status.permission === 'inputMonitoring' ? 'Input Monitoring needed' : 'Screen Recording needed'
  currentStatus = status.kind === 'idle' ? 'Ready when you are' : label.textContent
  document.getElementById('peek-status')!.textContent = currentStatus
}
function renderPeek(snapshot: AppSnapshot): void {
  document.getElementById('peek-status')!.textContent = snapshot.status || currentStatus
  document.getElementById('stop')!.hidden = !snapshot.busy
  document.getElementById('privacy')!.textContent = snapshot.saved ? 'Local text & drawing history' : 'Not saved'
  const recent = document.getElementById('recent')!; recent.replaceChildren()
  document.getElementById('recent-empty')!.hidden = snapshot.conversations.length > 0
  recent.hidden = snapshot.conversations.length === 0
  for (const c of [...snapshot.conversations].sort((a,b) => b.updated - a.updated).slice(0,3)) {
    const button = document.createElement('button'); button.className = 'recent'; button.textContent = c.title
    button.onclick = () => window.heynimbo.sendNotchEvent({ kind: 'home', id: c.id }); recent.append(button)
  }
}
function isOver(event: MouseEvent): boolean {
  return [pill, ...(peek.hidden ? [] : [peek])].some(node => { const r = node.getBoundingClientRect(); return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom })
}
let over = false
window.addEventListener('mousemove', event => {
  const hit = isOver(event)
  if (hit === over) return
  over = hit
  window.heynimbo.sendNotchEvent({ kind: 'hover', over: hit })
  if (hit) {
    clearTimeout(leaveTimer)
    if (!suppressed && peek.hidden) {
      if (peek.getAnimations().some(animation => animation.playState === 'running')) setPeek(true)
      else enterTimer = setTimeout(() => setPeek(true), hoverDwell)
    }
  } else {
    clearTimeout(enterTimer); suppressed = false
    if (!peek.hidden) leaveTimer = setTimeout(() => setPeek(false), leaveGrace)
  }
})
surface.addEventListener('mouseleave', () => {
  over = false; suppressed = false; clearTimeout(enterTimer)
  window.heynimbo.sendNotchEvent({ kind: 'hover', over: false })
  clearTimeout(leaveTimer)
  leaveTimer = setTimeout(() => setPeek(false), leaveGrace)
})
pill.onclick = () => window.heynimbo.sendNotchEvent({ kind: 'home' })
document.getElementById('home')!.onclick = () => window.heynimbo.sendNotchEvent({ kind: 'home' })
document.getElementById('new')!.onclick = () => window.heynimbo.sendNotchEvent({ kind: 'new' })
document.getElementById('stop')!.onclick = () => window.heynimbo.sendNotchEvent({ kind: 'stop' })
document.addEventListener('keydown', event => { if (event.key === 'Escape') dismiss() })
window.heynimbo.onNotchStatus(render)
window.heynimbo.onPeekSnapshot(renderPeek)
window.heynimbo.onPeekDismiss(dismiss)
