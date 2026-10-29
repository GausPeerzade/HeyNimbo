import { SseParser } from '../openai/sse'

export const BRAIN_MODEL = 'gpt-6.1-terra'

const INSTRUCTIONS = `You are NimboGuide, a friendly helper who lives on the user's computer.
The user is speaking to you out loud while looking at their screen. The attached image is the display under their mouse pointer, and the pointer position is given in image pixels.
Your reply is read aloud, so write it to be heard:
- Lead with the answer. Keep it to one to three short sentences unless they ask for more.
- Never use markdown, lists, emoji, code blocks or raw URLs.
- When you mention something on screen, name it by its label, look and position so they can find it.
- If the screenshot doesn't show what they're asking about, say so in a sentence and suggest what to look at.

You can also draw on their screen to show what you mean. Write each drawing command on its own line, starting with @, just before the sentence it goes with. Commands are drawn as that sentence is spoken and are never read aloud. Coordinates are pixels in the screenshot, from its top-left corner; aim at the center of the thing you mean.
@point X Y "label"    fly a pointer to one thing and label it (best for "where is...")
@circle X Y R         circle something
@box X Y W H          outline an area
@highlight X Y W H    highlight a line of text or a row
@arrow X1 Y1 X2 Y2    an arrow from one place to another
@line X1 Y1 X2 Y2     underline or connect two things
@text X Y "words"     a short handwritten note
@arc X Y R START SWEEP  part of a circle; angles in degrees, 0 is three o'clock, positive turns clockwise (-90 is straight up)
@curve X1 Y1 X2 Y2 ...  a smooth freehand line through 2 to 24 points
@dot X Y R            a small filled dot
@clear                erase your earlier drawings
Use drawings to point things out, and also to sketch when they ask you to draw something. Sketch it as a simple line drawing in an empty area or where they point, built from arcs, curves, lines and dots. For example, a Wi-Fi symbol is a dot with three nested arcs above it, each sweeping about 90 degrees around straight up (start -135, sweep 90). Never refuse a request to draw; do your best simple sketch. Use at most twelve commands per answer, and don't draw without a screenshot.`

export interface Exchange {
  question: string
  answer: string
}

export interface Screenshot {
  jpeg: Buffer
  width: number
  height: number
  cursor?: { x: number; y: number }
}

/** Streams the spoken answer as text deltas. Throws if the request fails. */
export async function* streamAnswer(options: {
  key: string
  question: string
  screenshot?: Screenshot
  history: readonly Exchange[]
  signal: AbortSignal
}): AsyncGenerator<string> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: BRAIN_MODEL,
      reasoning: { effort: 'low' },
      instructions: INSTRUCTIONS,
      input: [...historyItems(options.history), questionItem(options.question, options.screenshot)],
      stream: true,
      store: false,
    }),
    signal: options.signal,
  })
  if (!response.ok || !response.body) throw new Error(`The answer request failed (${response.status}).`)
  const parser = new SseParser()
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
      const data = JSON.parse(event.data) as { type?: string; delta?: string; response?: { error?: { message?: string } } }
      if (data.type === 'response.output_text.delta' && data.delta) yield data.delta
      else if (data.type === 'response.failed' || data.type === 'error')
        throw new Error(data.response?.error?.message ?? 'The answer failed.')
    }
  }
}

function historyItems(history: readonly Exchange[]): object[] {
  return history.flatMap(({ question, answer }) => [
    { role: 'user', content: question },
    { role: 'assistant', content: answer },
  ])
}

function questionItem(question: string, screenshot: Screenshot | undefined): object {
  if (!screenshot) return { role: 'user', content: `${question}\n\n(No screenshot was available.)` }
  const pointer = screenshot.cursor
    ? `The mouse pointer is at x=${Math.round(screenshot.cursor.x)}, y=${Math.round(screenshot.cursor.y)} in this ${screenshot.width}x${screenshot.height} screenshot.`
    : 'The mouse pointer is on another display.'
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: `${question}\n\n(${pointer})` },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${screenshot.jpeg.toString('base64')}`, detail: 'auto' },
    ],
  }
}
