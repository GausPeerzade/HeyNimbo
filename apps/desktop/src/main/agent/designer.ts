import { streamText } from 'ai'
import { sdkModel, type AnswerConnection } from '../answer-provider'
import { noRedirectFetch } from '../provider-settings'
import { ModelDesign } from '../../shared/model-design'
import type { ModelCommand } from '../../shared/model-protocol'

/** A dedicated 3D designer, after D-Shift's model tool (github.com/Kylejeong2/d-shift, MIT): the spoken
 *  answer only opens the 3D card, and this request builds the model in it, one JSON line per part,
 *  while the answer keeps talking. Lines describe shapes; nothing generated ever runs. */
export const DESIGNER_INSTRUCTIONS = `You are a 3D designer making a showpiece model for a native viewer, the kind of thing people screenshot and share. The model sits on a paper card over the user's screen, lit by soft studio lighting with reflections and shadows; it turns slowly so they see it from every side.

Before writing anything, decide the most striking and explanatory way to show the subject: a cutaway with the shell peeled back, an exploded view with parts floating apart along their axes, a translucent x-ray shell with glowing internals, a precise scientific illustration, a stylized sculpture. Commit to one direction and execute it with craft:
- Accurate proportions and silhouette first; a viewer should recognize it before any label appears.
- Smooth, continuous forms. Build organic and curved shapes from lathes and tapered tubes, not stacks of spheres and capsules, which look lumpy. Join pieces so seams overlap rather than leaving gaps.
- Detail where it matters. 150 to 600 parts is normal; repeat elements (bolts, ribs, teeth, atoms, panels, windows, spokes) instead of leaving surfaces bare.
- A deliberate palette: two or three hues plus neutrals, not a rainbow. Contrast materials: brushed metal (metalness 0.9, roughness 0.3), matte (roughness 0.8), gloss (roughness 0.1), glass (opacity 0.25).
- Emission for energy, flow, heat, signal, or to make the key part pop.
- Make moving parts move: rotors, wheels, gears, orbits.

Output JSON Lines only: one complete JSON object per line, no prose, no markdown fences, no wrapping array. Each line appears the moment it arrives, so build in a satisfying order: silhouette and main masses first, then structure, then fine detail, then labels.

First line: {"title":"Short name","concept":"One sentence: your design direction, palette, and what it emphasizes"}
Give every major part a short unique "id" (like "torso", "left-wing", "blade-set").

Positions are scene units with y up; keep the whole model within about -5..5 on every axis, centered near the origin. Rotations are degrees.
{"shape":"sphere","position":[x,y,z],"radius":r}
{"shape":"box","position":[x,y,z],"size":[w,h,d],"rotation":[rx,ry,rz]}
{"shape":"cylinder","from":[x,y,z],"to":[x,y,z],"radius":r}   rods, shafts, struts, bonds, wheels (short and wide)
{"shape":"capsule","from":[x,y,z],"to":[x,y,z],"radius":r}   rounded rods, limbs, pills
{"shape":"cone","from":[x,y,z],"to":[x,y,z],"radius":r}   base at from, tip at to
{"shape":"torus","position":[x,y,z],"ringRadius":R,"pipeRadius":r,"rotation":[rx,ry,rz]}   flat in the xz plane before rotation
{"shape":"tube","points":[[x,y,z],...],"radius":r}   smooth curve through up to 200 points: strands, cables, orbits, flows, tails, horns, tentacles. Add "radii":[r,...] (one per point) to taper it: limbs, necks, tails
{"shape":"lathe","profile":[[radius,y],...],"position":[x,y,z],"rotation":[rx,ry,rz]}   a smooth surface of revolution around the local y axis, from a profile listed bottom to top: torsos, bodies, heads, vases, bottles, domes, fuselages, hulls, nose cones. Use 8 to 30 profile points for a smooth silhouette; rotation [90,0,0] lays it along z
{"shape":"extrude","points":[[x,y],...],"depth":d,"position":[x,y,z],"rotation":[rx,ry,rz]}   a 2D outline (in the xy plane, centered near 0,0) extruded along z: blades, airfoils, wings, fins, plates, brackets, letters; rotation [90,0,0] lays it flat
{"label":"Text","position":[x,y,z]}   a label of one to three words on the part nearest that point; at most 6, only on the parts that explain the idea

Materials: define each once, then reference it with "m" on shapes (keys on a shape override its material):
{"mat":"pearl","color":"#rrggbb","metalness":0.1,"roughness":0.35}   also "opacity" (0..1) and "emission":"#rrggbb"
{"shape":"sphere","position":[0,1,0],"radius":0.2,"m":"pearl"}
Use a handful of materials, declared up front, rather than repeating colors on every line.

Repeats: any shape can take "repeat" to place copies, so write one line instead of many (at most 64 copies):
"repeat":{"count":3,"axis":[0,0,1],"pivot":[x,y,z]}   copies spread evenly around the axis through pivot (blades, teeth, bolts, spokes, petals); add "angle":90 to spread across 90 degrees instead of a full turn
"repeat":{"count":12,"step":[dx,dy,dz]}   copies offset by step each (rows of panels, rungs, vertebrae, windows)
Groups move together. Declare a group before its parts:
{"group":"rotor","pivot":[x,y,z],"spin":[ax,ay,az],"rps":0.3}   parts with "group":"rotor" spin around the axis through pivot, rps turns per second (0 for a static group). The spin axis is the x, y or z axis nearest the one you give, so lay spinning parts along one of them. Keep spins calm: 0.05 to 0.5 rps. Give parts their position in model space; the group handles the pivot.

Playbooks. Use the one that fits; they apply to any subject in the category.
- Creatures and characters: lathe the torso, head, and snout; tapered tubes ("radii") for limbs, necks, tails, and fingers, overlapping into the body at joints; spheres only for eyes and joint caps. Check leg count, symmetry, and that feet touch one ground plane. Give the pose some life.
- Vehicles and machines: a lathe or box for the main hull, extrudes for fins, wings, blades, brackets, and panels, cylinders for axles, wheels and pistons, repeats for wheels, bolts, vents, and teeth. Show function: a cutaway or exploded layer, and spin what spins.
- Architecture: massing first (boxes and extrudes), then repeated windows, columns, and ribs with "step"; a thin ground plate; warm emissive windows for life.
- Molecules and chemistry: CPK colors (C #3c3c3c, H #ffffff, O #e8322e, N #3050f8, S #ffd23f, P #ff8000), atoms scaled by element, bonds as cylinders, double bonds as two thin parallel cylinders; real geometry (tetrahedral 109.5, planar rings 120).
- Astronomy: compress distances and sizes but keep order and ratios readable; orbits as thin emissive tubes; a glowing star; rings as tori or flat extrudes.
- Anatomy and biology: lathes for organs and vessels, tapered tubes for branching structures, translucent outer layers over colored internals.
- Plants and nature: tapered tubes for stems and branches, extruded leaf and petal outlines repeated around an axis, slight variation so it doesn't look printed.
- Products and objects: lathes for anything turned (cups, bottles, lenses), boxes with small chamfered details, one hero material.
- Math and data: tubes for curves, grids of thin tubes for surfaces, emissive color ramps for value.

Speed matters: the user is watching it build. Use repeats and materials wherever they fit, write numbers with at most 2 decimals, and spend parts on what makes the model read well, not on invisible interior detail. Compute coordinates yourself (helices, rings, surfaces of revolution, airfoils).`

/** Earlier builds this session, so "again" or "better" explores something new instead of repeating itself. */
const previous: string[] = []

/** Polish pass, after D-Shift's: the designer sees its first build rendered and fixes it in place. */
export const POLISH_INSTRUCTIONS = `

Polish pass. You built the model below and can now see it rendered. The user is already looking at it, so improve it in place rather than starting over. Look hard at the image: proportions, silhouette, gaps between parts, floating or intersecting pieces, lumpy forms, missing defining features, flat or muddy materials. Then output only JSON Lines that fix and enrich it:
- {"remove":"id"} deletes a part; a shape line with an existing "id" replaces that part. Removing or replacing a group also removes the parts in it.
- New parts, materials and groups use the same format as before; the materials you declared are still defined.
- Labels already shown stay. A label line adds one to the part nearest its position: add one only where an important part has none.
Prioritize the fixes a viewer would notice first. Don't repeat the title line. At most about 80 lines.`

/** A model that hasn't finished by now keeps what it built; the turn must not wait on a stalled request. */
export const DESIGN_TIMEOUT_MS = 120_000
const POLISH_TIMEOUT_MS = 90_000
/** The first build's lines, as the polish pass reads them back; bounded so a huge build can't flood the request. */
const MAX_POLISH_INPUT = 60_000

/** Streams the model for one 3D card as batches of commands, as each line completes. With `snapshot`
 *  and a model that sees images, a polish pass then looks at the build and streams fixes into it;
 *  `onBuilt` fires between the two, so a caller need not wait for the polish. */
export async function* designModel(input: {
  connection: AnswerConnection; id: string; title: string; question: string; signal: AbortSignal
  snapshot?: () => Promise<Buffer | undefined>; onBuilt?: () => void
}): AsyncGenerator<ModelCommand[]> {
  const { connection } = input
  let built = false
  const done = (): void => { if (!built) { built = true; input.onBuilt?.() } }
  try {
    const key = await connection.credential()
    const design = new ModelDesign(input.id), lines: string[] = []
    const prompt = [
      `Build: ${input.title}`, `The user asked: ${input.question}`,
      ...(previous.length ? ['Already built this session (make this one clearly different if the request asks to redo or improve):', ...previous.slice(-4).map(item => `- ${item}`)] : []),
    ].join('\n')
    yield* pass({ key, connection, design, lines, instructions: DESIGNER_INSTRUCTIONS, prompt, signal: input.signal, timeoutMs: DESIGN_TIMEOUT_MS })
    if (design.title) previous.push(`${design.title}: ${design.concept}`)
    done()
    if (!input.snapshot || !connection.vision || input.signal.aborted || !design.size) return
    const image = await input.snapshot()
    if (!image || input.signal.aborted) return
    let record = lines.join('\n')
    if (record.length > MAX_POLISH_INPUT) record = record.slice(0, MAX_POLISH_INPUT)
    const text = [`Request: ${input.title}`, `The user asked: ${input.question}`, `Your design concept: ${design.concept}`,
      'The attached image is your first build, as the user sees it now (labels are drawn separately and are not in the image). Its JSON Lines:', record].join('\n')
    const before = lines.length, started = Date.now()
    try {
      yield* pass({ key, connection, design, lines, instructions: DESIGNER_INSTRUCTIONS + POLISH_INSTRUCTIONS, image, prompt: text, signal: input.signal, timeoutMs: POLISH_TIMEOUT_MS, maxOutputTokens: 8_000 })
    } catch (error) {
      // A failed polish leaves the first build as it is; only the user's Stop is an error worth reporting.
      if (input.signal.aborted) throw error
      console.warn(`[design] polish skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    console.info(`[design] polished ${design.title || input.title}: ${lines.length - before} lines in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  } finally { done() }
}

/** One streamed request: each completed line becomes commands at once. A deadline ends it quietly with what it built. */
async function* pass(options: {
  key: string; connection: AnswerConnection; design: ModelDesign; lines: string[]; instructions: string; prompt: string
  image?: Buffer; signal: AbortSignal; timeoutMs: number; maxOutputTokens?: number
}): AsyncGenerator<ModelCommand[]> {
  const { connection, design, lines } = options
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  if (signal.aborted) return
  const result = streamText({
    model: sdkModel(connection, options.key, noRedirectFetch), instructions: options.instructions, abortSignal: signal,
    ...(options.image
      ? { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: options.prompt }, { type: 'file' as const, data: options.image, mediaType: 'image/jpeg' }] }] }
      : { prompt: options.prompt }),
    // The design is long; low thinking starts the first part sooner, and a designed model rarely needs more.
    maxOutputTokens: options.maxOutputTokens ?? 32_000, maxRetries: 0, onError: () => {},
    providerOptions: {
      openai: { store: false, systemMessageMode: 'developer', reasoningEffort: 'low', ...(connection.provider === 'openai' && connection.speed ? { serviceTier: connection.speed } : {}) },
      anthropic: { effort: 'low' },
      deepseek: { thinking: { type: 'disabled' } },
    },
  })
  const take = (line: string): ModelCommand[] => {
    if (line.trim().startsWith('{')) lines.push(line.trim())
    return design.push(line)
  }
  let pending = ''
  try {
    for await (const delta of result.textStream) {
      pending += delta
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const commands = take(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        if (commands.length) yield commands
      }
    }
  } catch (error) {
    if (!signal.aborted || options.signal.aborted) throw error
  }
  const last = signal.aborted ? [] : take(pending)
  if (last.length) yield last
}
