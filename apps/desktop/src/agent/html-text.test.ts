import { expect, it } from 'vitest'
import { htmlToText } from './html-text'

it.each(['<'.repeat(5 * 1024 * 1024), `<a x="${'<'.repeat(5 * 1024 * 1024)}`, '<a '.repeat(1_747_627)])('extracts pathological 5 MB markup in linear time', html => {
  const started = performance.now()
  const result = htmlToText(html, 100)
  const elapsed = performance.now() - started
  expect(result.text.length).toBeLessThanOrEqual(100)
  expect(elapsed).toBeLessThan(500)
})

it('resolves at most 100 HTTP links against the page URL or its base element', () => {
  const html = '<base href="/docs/"><a href="guide?a=1&amp;b=2">Read <b>this</b></a><a href=javascript:alert(1)>bad</a><a href="https://u:p@evil.test/">bad</a>' + '<a href=next>Next</a>'.repeat(105)
  const result = htmlToText(html, 30, 'https://example.com/news/article')
  expect(result.links).toHaveLength(100)
  expect(result.links[0]).toEqual({ url: 'https://example.com/docs/guide?a=1&b=2', text: 'Read this' })
  expect(result.links[1]).toEqual({ url: 'https://example.com/docs/next', text: 'Next' })
  expect(result.text.length).toBeLessThanOrEqual(30)
})

it('handles comments, malformed attributes, nested templates and self-closing SVG without leaking hidden text', () => {
  const page = htmlToText(`<!-- hidden --><template>A<template>B</template>C</template><svg/><p>Visible</p><a disabled data-x='ignored' href = '/next' > A   B </a><a name=bookmark>No URL</a><!-- unfinished`, 100, 'https://example.com')
  expect(page.text).toBe('Visible\nA B No URL')
  expect(page.links).toEqual([{ url: 'https://example.com/next', text: 'A B' }])
})

it('decodes bounded numeric entities and leaves unknown names inert', () => {
  expect(htmlToText('&#65; &#X42; &#0; &#xD800; &#1114112; &unknown; &copy; &quot;', 100).text).toBe('A B � � � &unknown; © "')
  expect(htmlToText('text', Number.NaN).text).toBe('')
  expect(htmlToText('<a href="relative">link</a><a href=":">other</a><a>plain</a>', 100).links).toEqual([])
  expect(htmlToText('<base href="javascript:evil"><a href=/ok>Good</a>', 100, 'https://example.com')).toMatchObject({ links: [{ url: 'https://example.com/ok', text: 'Good' }] })
})

it('does not treat script strings or self-closing nested SVG as unclosed hidden elements', () => {
  const page = htmlToText('<script>const tag = "<script>"</script><svg><svg/></svg><p>Visible</p>', 100)
  expect(page.text).toBe('Visible')
})

it('extracts entity-decoded title, headings and list lines without active content', () => {
  const result = htmlToText('<title>A &amp; B</title><script>leak()</script><style>hidden</style><noscript>hidden</noscript><svg>hidden</svg><template>hidden</template><h1>Hello&nbsp;world</h1><p>A &lt; B &#x1f600; &#39;ok&#39;</p><ul><li>First</li><li>Second</li></ul>', 1000)
  expect(result.title).toBe('A & B')
  expect(result.text).toBe("Hello world\nA < B 😀 'ok'\n- First\n- Second")
  expect(result.links).toEqual([])
})
