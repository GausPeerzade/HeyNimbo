import type { NimboAppApi } from '../preload/app'
import type { AppRequest, AppSnapshot } from '../shared/app'
declare global { interface Window { nimboApp: NimboAppApi } }
export const request = async (value: AppRequest): Promise<unknown> => {
  try { return await window.nimboApp.request(value) }
  catch (error) { const status = document.getElementById('feedback'); if (status) status.textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method[^:]*: /, '') : 'This action failed. Try again.'; return undefined }
}
export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node
}
export function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const node = element('button', className, text); node.type = 'button'; node.onclick = action; return node
}
export const isSnapshot = (value: unknown): value is AppSnapshot => Boolean(value && typeof value === 'object' && 'conversations' in value)
// Lucide icons (notices in the root).
const paths = {
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m5 12 7-7 7 7M12 19V5"/>',
  general: '<path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6"/>',
  voice: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.5-6.2L3 8m0-5v5h5m4-1v5l3 2"/>',
  connection: '<path d="m10 13 4-4m-5 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
}
export function icon(name: keyof typeof paths): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('width', '18'); node.setAttribute('height', '18'); node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '1.7'); node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); node.setAttribute('aria-hidden', 'true'); node.innerHTML = paths[name]
  return node
}
