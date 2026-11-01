import type { HeyNimboAppApi } from '../preload/app'
import type { AppRequest, AppSnapshot } from '../shared/app'
declare global { interface Window { heynimboApp: HeyNimboAppApi } }
export const request = async (value: AppRequest): Promise<unknown> => {
  try { return await window.heynimboApp.request(value) }
  catch (error) { const status = document.getElementById('feedback'); if (status) status.textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method[^:]*: /, '') : 'This action failed. Try again.'; return undefined }
}
export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node
}
export function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const node = element('button', className, text); node.type = 'button'; node.onclick = action; return node
}
export const isSnapshot = (value: unknown): value is AppSnapshot => Boolean(value && typeof value === 'object' && 'conversations' in value)
// Lucide icons, unmodified (notices in the root): panel-left, plus, arrow-up, sliders-horizontal, mic, rotate-ccw-clock, link, info.
const paths = {
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  general: '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  voice: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  connection: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  about: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
}
export function icon(name: keyof typeof paths): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('width', '16'); node.setAttribute('height', '16'); node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '2'); node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); node.setAttribute('aria-hidden', 'true'); node.innerHTML = paths[name]
  return node
}
