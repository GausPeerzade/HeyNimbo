export interface TextLink { url: string; text: string }
interface TextPage { title: string; text: string; links: TextLink[] }
const hidden = new Set(['script', 'style', 'noscript', 'svg', 'template'])
const blocks = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'blockquote', 'pre', 'br', 'hr', 'tr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®' }
function decode(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]{1,8}|[0-9]{1,8})|[a-z]{2,12});/gi, (whole: string, name: string) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? whole
    const n = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�'
  })
}

function hrefAttribute(tag: string): string | undefined {
  for (let i = 0; i < tag.length;) {
    while (i < tag.length && /[\s/]/.test(tag[i]!)) i++
    const start = i
    while (i < tag.length && !/[\s=/>]/.test(tag[i]!)) i++
    const name = tag.slice(start, i).toLowerCase()
    while (i < tag.length && /\s/.test(tag[i]!)) i++
    if (tag[i] !== '=') { i++; continue }
    i++
    while (i < tag.length && /\s/.test(tag[i]!)) i++
    const quote = tag[i] === '"' || tag[i] === "'" ? tag[i++] : undefined
    const valueStart = i
    while (i < tag.length && (quote ? tag[i] !== quote : !/\s|>/.test(tag[i]!))) i++
    if (name === 'href') return decode(tag.slice(valueStart, i))
    if (quote) i++
  }
  return undefined
}
function webURL(value: string | undefined, base: string | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined
  try {
    const url = new URL(value, base)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Malformed links are untrusted text, not navigation. */ }
  return undefined
}

/** A forward-only tokenizer: malformed tags never restart a suffix scan. */
export function htmlToText(html: string, maxChars: number, baseURL?: string): TextPage {
  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0
  const parts: string[] = []
  const links: TextLink[] = []
  let active: TextLink | undefined, base = baseURL, baseUsed = false
  let length = 0, title = '', inTitle = false, suppressed = '', depth = 0
  const append = (value: string): void => {
    if (length >= cap) return
    const piece = value.slice(0, cap - length)
    parts.push(piece)
    length += piece.length
  }
  const text = (value: string): void => {
    if (suppressed) return
    const clean = decode(value).replace(/\s+/g, ' ')
    if (inTitle) title += clean.slice(0, Math.max(0, 512 - title.length))
    else {
      append(clean)
      if (active) active.text = (active.text + clean).replace(/\s+/g, ' ').slice(0, 200)
    }
  }
  let nextAngle = html.indexOf('>')
  for (let i = 0; i < html.length;) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i)
      const end = next < 0 ? html.length : next
      text(html.slice(i, end))
      i = end
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    const closing = html[i + 1] === '/'
    let cursor = i + (closing ? 2 : 1)
    const start = cursor
    while (cursor < html.length && /[a-z0-9]/i.test(html[cursor]!)) cursor++
    if (cursor === start) {
      // Collapse runs of malformed '<' in one write, not millions of regex calls.
      const from = i
      const count = /^<+/.exec(html.slice(i))![0].length
      i += count > 1 && i + count < html.length ? count - 1 : count
      text(html.slice(from, i))
      continue
    }
    if (nextAngle < i && nextAngle !== -1) nextAngle = html.indexOf('>', i)
    if (nextAngle === -1) break
    const name = html.slice(start, cursor).toLowerCase()
    const attributeStart = cursor
    let quote = ''
    while (cursor < html.length) {
      const char = html[cursor]!
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>' || char === '<') break
      cursor++
    }
    if (cursor >= html.length) break
    if (html[cursor] === '<') { i = cursor; continue }
    i = cursor + 1
    const selfClosing = /\/\s*$/.test(html.slice(attributeStart, cursor))
    if (suppressed) {
      if (name === suppressed) {
        if (closing) depth--
        else if (!selfClosing && (name === 'svg' || name === 'template')) depth++
        if (!depth) suppressed = ''
      }
      continue
    }
    if (hidden.has(name) && !closing) {
      if (!selfClosing) { suppressed = name; depth = 1 }
      continue
    }
    if (name === 'base' && !closing && !baseUsed) {
      base = webURL(hrefAttribute(html.slice(attributeStart, cursor)), base) ?? base
      baseUsed = true
    }
    if (name === 'a') {
      if (active) active.text = active.text.trim()
      active = undefined
      if (!closing && links.length < 100) {
        const url = webURL(hrefAttribute(html.slice(attributeStart, cursor)), base)
        if (url) { active = { url, text: '' }; links.push(active) }
      }
    }
    if (name === 'title') { inTitle = !closing; continue }
    if (blocks.has(name)) append('\n')
    if (name === 'li' && !closing) append('- ')
  }
  if (active) active.text = active.text.trim()
  return { title: title.trim(), text: parts.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+/g, '\n').trim(), links }
}
