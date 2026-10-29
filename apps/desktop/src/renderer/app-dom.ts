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
// Lucide: panel-left, plus and arrow-up (notices in the root).
const paths = {
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m5 12 7-7 7 7M12 19V5"/>',
}
export function icon(name: keyof typeof paths): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('width', '18'); node.setAttribute('height', '18'); node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '1.7'); node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); node.setAttribute('aria-hidden', 'true'); node.innerHTML = paths[name]
  return node
}
