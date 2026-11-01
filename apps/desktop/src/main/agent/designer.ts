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

/** Streams the model for one 3D card as batches of commands, as each line completes. */
/** A model that hasn't finished by now keeps what it built; the turn must not wait on a stalled request. */
export const DESIGN_TIMEOUT_MS = 120_000

export async function* designModel(input: { connection: AnswerConnection; id: string; title: string; question: string; signal: AbortSignal }): AsyncGenerator<ModelCommand[]> {
  const { connection } = input
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(DESIGN_TIMEOUT_MS)])
  const key = await connection.credential()
  if (signal.aborted) return
  const design = new ModelDesign(input.id)
  const prompt = [
    `Build: ${input.title}`, `The user asked: ${input.question}`,
    ...(previous.length ? ['Already built this session (make this one clearly different if the request asks to redo or improve):', ...previous.slice(-4).map(item => `- ${item}`)] : []),
  ].join('\n')
  const result = streamText({
    model: sdkModel({ ...connection, vision: false }, key, noRedirectFetch), instructions: DESIGNER_INSTRUCTIONS, prompt, abortSignal: signal,
    // The design is long; low thinking starts the first part sooner, and a designed model rarely needs more.
    maxOutputTokens: 32_000, maxRetries: 0, onError: () => {},
    providerOptions: {
      openai: { store: false, systemMessageMode: 'developer', reasoningEffort: 'low', ...(connection.provider === 'openai' && connection.speed ? { serviceTier: connection.speed } : {}) },
      anthropic: { effort: 'low' },
      deepseek: { thinking: { type: 'disabled' } },
    },
  })
  let pending = ''
  // A deadline ends the stream quietly: the parts already built stay.
  try {
  for await (const delta of result.textStream) {
    pending += delta
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const commands = design.push(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      if (commands.length) yield commands
    }
  }
  } catch (error) {
    if (!signal.aborted || input.signal.aborted) throw error
  }
  const last = signal.aborted ? [] : design.push(pending)
  if (last.length) yield last
  if (design.title) previous.push(`${design.title}: ${design.concept}`)
}
