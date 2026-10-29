import { BeatParser, type ImageSize, type Mark } from '../shared/beats'

export interface FixtureRect { x: number; y: number; w: number; h: number }
export interface ModelFixture {
  name: string
  /** Sentences after which the gallery captures a build stage; the end is always captured. */
  stages: number[]
  /** An answer as the model would write it, with its cards placed in these rects. */
  script: (model: FixtureRect, side: FixtureRect) => string
}

const rect = (r: FixtureRect): string => [r.x, r.y, r.w, r.h].map(Math.round).join(' ')

/** Original subjects only, none of them an engine. */
export const MODEL_FIXTURES: readonly ModelFixture[] = [
  { name: 'pump', stages: [2, 4], script: (model, side) => `@model pump ${rect(model)} "Inside a floor pump" turntable=true
@card pressure ${rect(side)} "Air on the move" grid
@heading pressure "Small pushes, high pressure"
A floor pump is a tall barrel with a plunger inside.
@part pump foot box w=1.9 h=0.12 d=0.8 round=0.04 at=0,-1.52,0 mat=steel color=grey
@part pump base lathe profile=0.56,-0.1;0.6,-0.04;0.6,0.05;0.5,0.12;0.44,0.14 at=0,-1.36,0 mat=steel color=grey
@part pump barrel tube r=0.44 inner=0.38 h=2.6 mat=steel
@part pump cap tube r=0.48 inner=0.07 h=0.14 at=0,1.33,0 mat=brass
@cut pump z
@tag pump barrel "Air chamber" left
I've cut the barrel open so you can see the air chamber.
@part pump rod cylinder r=0.06 h=1.7 at=0,1.5,0 mat=steel
@part pump handle capsule r=0.07 h=1.1 turn=0,0,90 at=0,0.85,0 in=rod mat=steel
@part pump grips capsule r=0.1 h=0.38 turn=0,0,90 at=-0.36,0.85,0 copies=2 step=0.72,0,0 in=rod mat=rubber
@tag pump handle "T-handle" right
Pulling the T-handle lifts the plunger rod.
@part pump piston cylinder r=0.34 h=0.16 at=0,-0.78,0 in=rod mat=brass
@part pump seals torus r=0.34 tube=0.024 at=0,-0.82,0 copies=2 step=0,0.08,0 in=rod mat=rubber
@tag pump seals "Cup seals" right
A brass piston with rubber seals fits snugly in the barrel.
@part pump valve sphere r=0.09 at=0,-1.18,0 mat=rubber
@part pump hose pipe points=0.42,-1.36,0.05;0.85,-1.42,0.18;1.2,-1.2,0.25;1.35,-0.6,0.2;1.3,-0.1,0.12 r=0.06 mat=rubber
@part pump head capsule r=0.11 h=0.36 at=1.3,0.05,0.12 mat=brass
@tag pump valve "One-way valve" left
@step pressure "Push to squeeze the air" down orange
Pushing down squeezes the air past a one-way valve into the hose.
@part pump gauge cylinder r=0.2 h=0.1 turn=90,0,-30 at=0.62,-1.2,0.32 mat=brass
@part pump dial cylinder r=0.17 h=0.012 at=0,0.055,0 in=gauge mat=paper
@part pump ticks box w=0.012 h=0.01 d=0.035 at=0,0.065,0.13 around=8 in=gauge mat=rubber
@part pump needle box w=0.02 h=0.012 d=0.13 at=0,0.07,0.05 turn=0,-35,0 in=gauge mat=plastic color=red
@tag pump gauge "Pressure gauge" left
@step pressure "The gauge shows the pressure" right blue
The gauge shows how hard the air pushes back.
@move pump rod slide axis=y amount=-1.3 period=3.5
@note pressure "The piston and seals move as one."
Each stroke pushes a little more air into the tire.
` },
  { name: 'fan', stages: [2, 3], script: (model) => `@model fan ${rect(model)} "Inside a desk fan" turntable=true
A desk fan is a small electric motor that spins a set of blades.
@part fan housing capsule r=0.3 h=0.95 turn=90,0,0 at=0,0.55,-0.25 mat=plastic color=grey
@cut fan x
@part fan stator tube r=0.24 inner=0.16 h=0.32 turn=90,0,0 at=0,0.55,-0.3 mat=steel
@part fan windings torus r=0.2 tube=0.05 turn=90,0,0 at=0,0.55,-0.42 copies=2 step=0,0,0.24 mat=copper
@part fan shaft cylinder r=0.025 h=1 turn=90,0,0 at=0,0.55,0.05 mat=steel
@tag fan windings "Copper windings" left
Inside the housing, current in the copper windings turns the shaft.
@part fan hub sphere r=0.12 half=true turn=90,0,0 at=0,0.55,0.45 mat=plastic color=grey
@part fan blades box w=0.46 h=0.02 d=0.26 round=0.01 turn=25,0,0 at=0.3,0,0 around=3 in=hub mat=plastic color=blue
@tag fan blades "Blades" right
The shaft spins three angled blades that push air forward.
@part fan guard torus r=0.66 tube=0.014 turn=90,0,0 at=0,0.55,0.5 mat=steel
@part fan spokes cylinder r=0.008 h=0.62 turn=0,0,90 at=0.33,0,0 around=12 in=guard mat=steel
@tag fan guard "Wire guard" right
A wire guard keeps fingers away from them.
@part fan neck cylinder r=0.06 h=1.15 at=0,-0.28,-0.25 mat=steel
@part fan base lathe profile=0,-0.06;0.6,-0.06;0.62,-0.02;0.55,0.06;0.2,0.12;0,0.13 at=0,-0.86,-0.25 mat=plastic color=grey
@part fan knob cylinder r=0.07 h=0.06 at=0.25,-0.74,0 mat=plastic color=red
@tag fan knob "Speed switch" left
A stand and a heavy base keep it steady, with the switch up front.
@move fan hub spin axis=z amount=360 period=1.2
Switch it on, and the blades spin.
` },
  { name: 'water', stages: [1, 2], script: (model) => `@model water ${rect(model)} "A water molecule" turntable=true
@part water oxygen sphere r=0.42 mat=plastic color=red
@tag water oxygen "Oxygen, slightly negative" left
A water molecule has one oxygen atom in the middle.
@part water bond-a cylinder r=0.07 h=1.2 turn=0,0,52.25 at=0.474,-0.367,0 in=oxygen mat=plastic color=grey
@part water bond-b cylinder r=0.07 h=1.2 turn=0,0,-52.25 at=-0.474,-0.367,0 in=oxygen mat=plastic color=grey
@part water hydrogens sphere r=0.26 at=0.95,-0.73,0 copies=2 step=-1.9,0,0 in=oxygen mat=paper
@tag water hydrogens "Hydrogen, slightly positive" right
@tag water bond-b "Shared electron pair" left
Two hydrogen atoms share electrons with it, about 104 degrees apart.
@part water lobe-a capsule r=0.2 h=0.75 turn=35,0,0 at=0,0.36,0.25 in=oxygen mat=glass color=blue
@part water lobe-b capsule r=0.2 h=0.75 turn=-35,0,0 at=0,0.36,-0.25 in=oxygen mat=glass color=blue
@tag water lobe-a "Lone pairs" right
Two lone pairs on the oxygen bend the molecule.
@move water oxygen spin axis=y amount=360 period=12
That bend is why water molecules stick together so well.
` },
  { name: 'gears', stages: [2, 3], script: (model) => `@model gears ${rect(model)} "A gear train" turntable=true
@part gears plate box w=3.4 h=2.5 d=0.12 round=0.04 at=0.06,0.03,-0.35 mat=wood
A gear train passes turning from one gear to the next.
@part gears drive gear r=0.36 teeth=12 w=0.16 hole=0.05 turn=90,0,0 at=-1,0.3,0 mat=brass
@part gears drive-axle cylinder r=0.05 h=0.5 at=0,-0.2,0 in=drive mat=steel
@part gears crank box w=0.5 h=0.05 d=0.08 at=0.22,0.12,0 in=drive mat=steel
@part gears knob cylinder r=0.05 h=0.22 at=0.42,0.24,0 in=drive mat=wood
@tag gears drive "Drive gear, 12 teeth" left
Turning the crank turns the small drive gear.
@part gears idler gear r=0.72 teeth=24 w=0.16 hole=0.05 turn=90,7.5,0 at=0.08,0.3,0 mat=steel
@part gears idler-axle cylinder r=0.05 h=0.5 at=0,-0.2,0 in=idler mat=steel
@tag gears idler "24 teeth, half the speed" right
Its teeth push the big gear around at half the speed, the other way.
@part gears output gear r=0.48 teeth=16 w=0.16 hole=0.05 turn=90,12.5,0 at=0.999,-0.471,0 mat=copper
@part gears output-axle cylinder r=0.05 h=0.5 at=0,-0.2,0 in=output mat=steel
@tag gears output "Output gear, 16 teeth" right
A third gear turns the same way as the first.
@move gears drive spin axis=z amount=360 period=4
@move gears idler spin axis=z amount=-360 period=8
@move gears output spin axis=z amount=360 period=5.333
Each pair of teeth trades speed for force.
` },
  { name: 'padlock', stages: [2, 3], script: (model) => `@model lock ${rect(model)} "Inside a padlock" turntable=true
@part lock body box w=1.5 h=1.25 d=0.7 round=0.12 mat=brass
@part lock plug cylinder r=0.2 h=0.72 turn=90,0,0 at=0,-0.2,0.01 mat=brass color=orange
@tag lock body "Brass body" left
A padlock hides a small pin-tumbler lock inside a solid body.
@cut lock x
@part lock keypins cylinder r=0.04 h=0.2 at=0,-0.06,-0.21 copies=4 step=0,0,0.14 mat=brass
@part lock drivers cylinder r=0.04 h=0.18 at=0,0.13,-0.21 copies=4 step=0,0,0.14 mat=steel
@part lock springs spring r=0.035 h=0.26 coils=6 wire=0.008 at=0,0.35,-0.21 copies=4 step=0,0,0.14 mat=steel
@tag lock drivers "Driver pins" right
@tag lock springs "Springs" right
Cut in half, you can see springs pushing pins down into the plug, so it can't turn.
@part lock key box w=0.04 h=0.16 d=0.62 at=0,-0.24,0.12 mat=steel color=grey
@part lock bow cylinder r=0.22 h=0.05 turn=90,0,0 at=0,-0.24,0.62 mat=steel color=grey
@tag lock key "Key" left
The right key lifts every pin to the shear line, and the plug turns.
@part lock shackle pipe points=-0.42,0.45,0;-0.42,1,0;-0.3,1.28,0;0,1.38,0;0.3,1.28,0;0.42,1,0;0.42,0.55,0 r=0.085 mat=steel
@tag lock shackle "Shackle" right
@move lock shackle bob axis=y amount=0.3 period=3
Then the shackle springs free.
` },
  { name: 'atom', stages: [1, 2], script: (model) => `@model atom ${rect(model)} "A carbon atom" turntable=true
@part atom protons sphere r=0.15 at=0.13,0.07,0 around=3 mat=plastic color=red
@part atom neutrons sphere r=0.15 at=-0.13,-0.07,0 around=3 mat=plastic color=grey
@part atom top sphere r=0.15 at=0,0.2,0 mat=plastic color=red
@part atom bottom sphere r=0.15 at=0,-0.2,0 mat=plastic color=grey
@tag atom protons "Nucleus" left
An atom has a tiny, heavy nucleus of protons and neutrons.
@part atom inner torus r=0.75 tube=0.008 turn=70,0,15 mat=steel
@part atom pair sphere r=0.07 at=0.75,0,0 around=2 in=inner mat=glow color=blue
@tag atom pair "Inner shell: 2 electrons" right
Two electrons move in the inner shell.
@part atom outer torus r=1.35 tube=0.008 turn=-60,0,-25 mat=steel
@part atom four sphere r=0.07 at=1.35,0,0 around=4 in=outer mat=glow color=blue
@tag atom four "Outer shell: 4 electrons" right
Four more fill the outer shell.
@move atom pair orbit axis=y period=2.5
@move atom four orbit axis=y amount=-1 period=4
They never stop moving.
` },
]

/** Speech-paced beats: about 330 ms per spoken word, as a stand-in for real audio. */
export function fixtureBeats(text: string, image: ImageSize): Array<{ durationMs: number; marks: Mark[]; sentence?: string }> {
  const parser = new BeatParser(image)
  return [...parser.push(text), ...parser.flush()].map((beat) => ({
    ...beat,
    durationMs: beat.sentence ? Math.min(4000, Math.max(1300, beat.sentence.split(/\s+/).length * 330 + 350)) : 1200,
  }))
}

/** Written from the INSTRUCTIONS text alone, as the model would answer, and
 *  rendered unchanged: they measure how well the kit generalizes. Never edit
 *  one to make it look better; fix the kit instead. */
export const BLIND_FIXTURES: readonly ModelFixture[] = [
  { name: 'rocket', stages: [2], script: (model) => `@model rocket ${rect(model)} "Inside a two-stage rocket" turntable=true
@part rocket stage1 tube r=0.4 inner=0.37 h=2 at=0,-0.8,0 mat=paint color=white
@part rocket stage2 tube r=0.4 inner=0.37 h=1.2 at=0,0.9,0 mat=paint color=white
@part rocket nose cone r=0.4 h=0.8 at=0,1.9,0 mat=paint color=red
A rocket is mostly fuel tanks stacked inside a tall, thin tube.
@cut rocket z
@part rocket fuel capsule r=0.34 h=0.9 at=0,-0.35,0 mat=steel
@part rocket oxidizer capsule r=0.34 h=0.9 at=0,-1.3,0 mat=steel color=blue
@tag rocket fuel "Fuel tank" left
@tag rocket oxidizer "Oxidizer tank" left
Inside the first stage, fuel and oxidizer wait to burn together.
@part rocket engine lathe profile=0.1,-1.85;0.18,-2.1;0.32,-2.4 mat=steel
@part rocket fins box w=0.35 h=0.6 d=0.04 at=0.5,-1.6,0 around=4 mat=paint color=grey
@part rocket flame cone r=0.28 h=0.8 turn=180,0,0 at=0,-2.8,0 mat=glow color=orange
@tag rocket engine "Engine bell" right
The engine bell shapes the hot gas into a fast jet, and the fins keep it steady.
@part rocket interstage cylinder r=0.4 h=0.15 at=0,0.25,0 mat=steel
@part rocket upper capsule r=0.3 h=0.7 at=0,0.75,0 mat=steel
@part rocket payload sphere r=0.25 at=0,1.75,0 mat=brass
@tag rocket payload "Payload" right
@tag rocket interstage "Interstage" right
Higher up, the second stage takes over and carries the payload under the nose cone.
@move rocket flame bob axis=y amount=0.08 period=0.4
Once it is lit, the flame pushes the whole stack upward.
` },
  { name: 'heart', stages: [2], script: (model) => `@model heart ${rect(model)} "The human heart" turntable=true
@part heart muscle blob w=1.4 h=1.7 d=1.1 lumps=0.12 seed=3 taper=0.45 turn=0,0,-20 mat=tissue color=red
The heart is a muscle about the size of your fist, tipped slightly to the left.
@cut heart view
@part heart lv blob w=0.5 h=0.85 d=0.45 at=-0.25,-0.25,0 mat=tissue color=red
@part heart rv blob w=0.45 h=0.7 d=0.4 at=0.25,-0.2,0.1 mat=tissue color=purple
@part heart la blob w=0.4 h=0.4 d=0.35 at=-0.3,0.45,-0.1 mat=tissue color=red
@part heart ra blob w=0.4 h=0.45 d=0.35 at=0.35,0.45,0.05 mat=tissue color=purple
@tag heart lv "Left ventricle" left
@tag heart rv "Right ventricle" right
@tag heart ra "Right atrium" right
Inside are four hollow chambers, and the ventricles at the bottom do the strong pumping.
@part heart aorta pipe points=-0.05,0.6,0;0,1.1,0;-0.35,1.25,0;-0.55,1,0 r=0.13 mat=tissue color=red
@part heart pulmonary pipe points=0.15,0.6,0.2;0.2,1,0.25;0.5,1.1,0.2 r=0.11 mat=tissue color=blue
@part heart vena pipe points=0.45,0.55,0;0.5,1.2,0 r=0.1 mat=tissue color=blue
@tag heart aorta "Aorta" left
Blood leaves through the aorta to the body, and through the pulmonary artery to the lungs.
@move heart muscle bob axis=y amount=0.04 period=0.9
It beats about seventy times a minute.
` },
  { name: 'solar', stages: [2], script: (model) => `@model solar ${rect(model)} "The inner solar system" turntable=true
@part solar sun sphere r=0.6 mat=glow color=yellow
@tag solar sun "Sun" left
The Sun sits at the center and holds everything in orbit.
@part solar mercury sphere r=0.08 at=1,0,0 mat=rock color=grey
@part solar venus sphere r=0.14 at=1.5,0,0 mat=rock color=yellow
@part solar earth sphere r=0.15 at=2.1,0,0 mat=paint color=blue
@part solar moon sphere r=0.05 at=0.3,0,0 in=earth mat=rock color=grey
@part solar mars sphere r=0.1 at=2.8,0,0 mat=rock color=red
@part solar path torus r=2.1 tube=0.01 mat=paper
@tag solar earth "Earth" right
@tag solar mars "Mars" right
@tag solar moon "Moon" left
The four rocky planets circle it, from Mercury out to Mars.
@move solar mercury orbit axis=y amount=1 period=3
@move solar venus orbit axis=y amount=1.5 period=6
@move solar earth orbit axis=y amount=2.1 period=10
@move solar mars orbit axis=y amount=2.8 period=18
The closer a planet is, the faster it goes around.
` },
  { name: 'house', stages: [2], script: (model) => `@model house ${rect(model)} "Inside a two-story house" turntable=true
@part house foundation box w=3 h=0.2 d=2 at=0,-0.1,0 mat=rock color=grey
@part house walls box w=2.8 h=2 d=1.8 at=0,1,0 mat=paint color=white
@part house roof extrude points=-1.6,0;1.6,0;0,1 d=2 at=0,2,0 mat=paint color=red
A house is a box of walls on a concrete foundation, under a sloping roof.
@cut house z
@part house floor box w=2.7 h=0.1 d=1.7 at=0,1,0 mat=wood
@part house stairs box w=0.4 h=0.12 d=0.3 at=-1,0.1,-0.5 copies=8 step=0,0.12,0.15 mat=wood
@tag house stairs "Stairs" left
@tag house floor "Upper floor" right
Cutting away the front shows an upper floor, with stairs between the levels.
@part house door box w=0.5 h=0.9 d=0.05 at=0.6,0.45,-0.9 mat=wood color=brown
@part house windows box w=0.5 h=0.5 d=0.05 at=-0.7,1.5,-0.9 copies=2 step=1.4,0,0 mat=glass
@part house chimney box w=0.3 h=0.8 d=0.3 at=0.8,2.6,0 mat=rock color=red
@tag house roof "Roof" right
@tag house chimney "Chimney" left
The roof sheds rain, and the chimney carries smoke up and out.
` },
  { name: 'volcano', stages: [2], script: (model) => `@model volcano ${rect(model)} "Inside a volcano" turntable=true
@part volcano bedrock box w=4 h=1.5 d=3 at=0,-1.05,0 mat=rock color=grey
@part volcano mountain lathe profile=2,-0.3;1.4,0.3;0.8,1;0.35,1.6;0.25,1.5;0,1.5 mat=rock color=brown
A volcano is a mountain built from layers of cooled lava and ash.
@cut volcano z
@part volcano chamber blob w=1.4 h=0.5 d=1 lumps=0.2 seed=5 at=0,-1.1,0 mat=glow color=orange
@tag volcano chamber "Magma chamber" left
Deep below it sits a chamber of molten rock.
@part volcano vent pipe points=0,-0.9,0;0.05,0.3,0;0,1.5,0 r=0.1 mat=glow color=red
@part volcano side pipe points=0.03,0.4,0;0.6,0.9,0 r=0.06 mat=glow color=red
@tag volcano vent "Main vent" right
@tag volcano mountain "Layers of rock" right
Magma rises up a narrow vent and bursts out of the crater.
@part volcano ash blob w=1.2 h=0.8 d=1 lumps=0.3 seed=2 at=0,2.3,0 mat=rock color=grey
@part volcano lava blob w=0.4 h=0.08 d=0.3 at=0.9,0.85,0.3 mat=glow color=orange
@tag volcano ash "Ash cloud" left
@move volcano ash bob axis=y amount=0.2 period=3
Ash and gas billow up into the sky.
` },
  { name: 'guitar', stages: [2], script: (model) => `@model guitar ${rect(model)} "An acoustic guitar" turntable=true
@part guitar body extrude points=0,-1;0.6,-0.85;0.7,-0.4;0.45,0;0.55,0.4;0.35,0.7;0,0.75;-0.35,0.7;-0.55,0.4;-0.45,0;-0.7,-0.4;-0.6,-0.85 d=0.35 smooth=true mat=wood
@part guitar hole cylinder r=0.17 h=0.02 turn=90,0,0 at=0,0.25,0.18 mat=rubber
@tag guitar hole "Sound hole" left
An acoustic guitar is a hollow wooden box that makes the strings louder.
@part guitar neck box w=0.18 h=1.6 d=0.1 at=0,1.5,0.05 mat=wood color=brown
@part guitar head box w=0.26 h=0.45 d=0.08 at=0,2.5,0.05 mat=wood color=brown
@part guitar frets box w=0.18 h=0.01 d=0.02 at=0,0.85,0.11 copies=12 step=0,0.12,0 mat=steel
@part guitar pegs cylinder r=0.03 h=0.12 turn=0,0,90 at=0.17,2.35,0.05 copies=3 step=0,0.12,0 mat=steel
@tag guitar frets "Frets" right
@tag guitar pegs "Tuning pegs" right
Frets on the neck mark the notes, and the pegs tune each string.
@part guitar bridge box w=0.45 h=0.08 d=0.05 at=0,-0.5,0.2 mat=wood color=brown
@part guitar strings cylinder r=0.006 h=3.1 at=-0.06,1.05,0.2 copies=6 step=0.024,0,0 mat=steel
@tag guitar bridge "Bridge" left
@tag guitar strings "Strings" left
@move guitar strings bob axis=z amount=0.01 period=0.3
Pluck a string and the whole body sings.
` },
  { name: 'bicycle', stages: [2], script: (model) => `@model bike ${rect(model)} "How a bicycle works" turntable=true
@part bike rear torus r=0.6 tube=0.05 turn=90,0,0 at=-1,0,0 mat=rubber
@part bike front torus r=0.6 tube=0.05 turn=90,0,0 at=1.1,0,0 mat=rubber
@part bike spokes cylinder r=0.008 h=1.1 turn=0,0,90 around=12 in=rear mat=steel
@part bike frame pipe points=-1,0,0;-0.2,-0.05,0;0.45,0.7,0;-0.45,0.75,0;-1,0,0 r=0.04 mat=paint color=red
@part bike fork pipe points=0.45,0.7,0;0.65,0.8,0;1.1,0,0 r=0.035 mat=steel
@tag bike frame "Frame" left
A bicycle is a light frame on two wheels.
@part bike crank gear r=0.18 teeth=32 w=0.03 turn=90,0,0 at=-0.2,-0.05,0.06 mat=steel
@part bike sprocket gear r=0.08 teeth=14 w=0.03 turn=90,0,0 at=-1,0,0.06 mat=steel
@part bike chain pipe points=-0.2,0.13,0.06;-1,0.08,0.06;-1,-0.08,0.06;-0.2,-0.23,0.06 r=0.012 mat=steel
@part bike pedals box w=0.1 h=0.03 d=0.12 at=-0.2,-0.25,0.15 mat=rubber
@tag bike crank "Chainring" right
@tag bike sprocket "Rear sprocket" left
The pedals turn a chain that drives the back wheel.
@part bike seat capsule r=0.06 h=0.3 turn=0,0,90 at=-0.45,0.85,0 mat=rubber
@part bike bars cylinder r=0.025 h=0.6 turn=90,0,0 at=0.65,0.95,0 mat=steel
@tag bike seat "Saddle" left
@tag bike bars "Handlebar" right
@move bike crank spin axis=z amount=-360 period=2
@move bike rear spin axis=z amount=-360 period=2
@move bike front spin axis=z amount=-360 period=2
You steer with the handlebar while your legs drive the chain.
` },
  { name: 'tree', stages: [2], script: (model) => `@model tree ${rect(model)} "How a tree grows" turntable=true
@part tree trunk cylinder r=0.15 top=0.09 h=1.6 at=0,0.8,0 mat=wood color=brown
@part tree roots pipe points=0,0.05,0;0.4,-0.1,0.1;0.8,-0.2,0.2 r=0.04 around=5 mat=wood color=brown
@part tree soil blob w=2.4 h=0.3 d=2.4 lumps=0.1 at=0,-0.15,0 mat=soil
@tag tree roots "Roots" left
A tree is a woody trunk that lifts its leaves up to the light, while roots drink from the soil.
@part tree branches pipe points=0,1.2,0;0.3,1.5,0;0.6,1.6,0.1 r=0.04 around=4 mat=wood color=brown
@part tree crown blob w=1.8 h=1.3 d=1.8 lumps=0.25 seed=4 at=0,2.1,0 mat=tissue color=green
@tag tree crown "Leaves" right
@tag tree trunk "Trunk" left
The leaves make sugar from sunlight, air and water.
@part tree apples sphere r=0.07 at=0.7,1.9,0.3 around=6 mat=paint color=red
@tag tree apples "Fruit" right
@move tree crown bob axis=x amount=0.03 period=3
That sugar feeds new wood, new leaves and fruit.
` },
  { name: 'castle', stages: [2], script: (model) => `@model castle ${rect(model)} "A medieval castle" turntable=true
@part castle ground box w=3.6 h=0.1 d=3.6 at=0,-0.05,0 mat=soil color=green
@part castle walls box w=2.6 h=0.9 d=0.2 at=0,0.45,1.2 copies=2 step=0,0,-2.4 mat=rock
@part castle sides box w=0.2 h=0.9 d=2.4 at=1.2,0.45,0 copies=2 step=-2.4,0,0 mat=rock
@part castle towers cylinder r=0.32 h=1.4 at=1.2,0.7,1.2 around=4 mat=rock
@part castle roofs cone r=0.38 h=0.5 at=1.2,1.65,1.2 around=4 mat=paint color=red
@tag castle towers "Towers" left
@tag castle walls "Curtain wall" right
A castle is a ring of thick stone walls with a tower at each corner.
@part castle keep box w=1 h=1.6 d=1 at=0,0.8,0 mat=rock
@part castle battlements box w=0.12 h=0.12 d=0.12 at=-0.4,1.66,0.45 copies=5 step=0.2,0,0 mat=rock
@tag castle keep "Keep" right
In the middle stands the keep, the last place to hold out.
@part castle gate box w=0.5 h=0.6 d=0.05 at=0,0.3,1.31 mat=wood color=brown
@part castle pole cylinder r=0.015 h=0.5 at=0,1.85,0 mat=wood
@part castle flag box w=0.3 h=0.18 d=0.01 at=0.15,2,0 mat=paint color=blue
@tag castle gate "Gatehouse" left
@move castle flag bob axis=x amount=0.03 period=1
A single gate let friends in and kept enemies out.
` },
  { name: 'dna', stages: [2], script: (model) => `@model dna ${rect(model)} "The DNA double helix" turntable=true
@part dna strand-a spring r=0.5 h=3 coils=3 wire=0.06 mat=paint color=blue
@part dna strand-b spring r=0.5 h=3 coils=3 wire=0.06 turn=0,180,0 mat=paint color=red
@tag dna strand-a "Backbone" left
DNA is two long strands twisted around each other like a ladder.
@part dna rungs cylinder r=0.035 h=1 turn=0,0,90 at=0,-1.4,0 copies=12 step=0,0.25,0 mat=paint color=green
@tag dna rungs "Base pairs" right
The rungs are pairs of bases: A pairs with T, and C pairs with G.
@move dna strand-a spin axis=y amount=360 period=8
@move dna strand-b spin axis=y amount=360 period=8
@move dna rungs spin axis=y amount=360 period=8
To copy itself, it unzips down the middle.
` },
  { name: 'coffee', stages: [2], script: (model) => `@model coffee ${rect(model)} "Inside an espresso machine" turntable=true
@part coffee case box w=1.6 h=1.8 d=1.2 round=0.08 at=0,0.9,0 mat=steel
An espresso machine heats water and forces it through coffee at high pressure.
@cut coffee x
@part coffee tank box w=0.4 h=0.9 d=0.8 at=-0.5,1.2,-0.1 mat=glass color=blue
@part coffee boiler cylinder r=0.25 h=0.6 turn=0,0,90 at=0.2,1.3,0 mat=copper
@tag coffee tank "Water tank" left
@tag coffee boiler "Boiler" right
Water from the tank is heated in the boiler.
@part coffee pump cylinder r=0.1 h=0.3 at=-0.1,0.6,0 mat=brass
@part coffee pipe pipe points=-0.5,0.7,0;-0.1,0.6,0;0.2,1,0;0.3,0.8,0.4 r=0.03 mat=copper
@tag coffee pump "Pump" left
A pump pushes the hot water to the group head.
@part coffee group cylinder r=0.18 h=0.2 at=0.3,0.7,0.5 mat=steel
@part coffee portafilter cylinder r=0.16 h=0.12 at=0.3,0.55,0.5 mat=steel
@part coffee handle capsule r=0.04 h=0.5 turn=90,0,0 at=0.3,0.55,0.85 mat=rubber
@part coffee cup tube r=0.15 inner=0.12 h=0.2 at=0.3,0.12,0.5 mat=paint color=white
@tag coffee portafilter "Portafilter" right
@tag coffee cup "Cup" right
Out comes a small, strong shot.
` },
  { name: 'drone', stages: [2], script: (model) => `@model drone ${rect(model)} "How a quadcopter flies" turntable=true
@part drone body box w=0.6 h=0.18 d=0.6 round=0.06 mat=plastic color=grey
@part drone arm-a box w=1.5 h=0.06 d=0.08 turn=0,45,0 mat=plastic color=grey
@part drone arm-b box w=1.5 h=0.06 d=0.08 turn=0,-45,0 mat=plastic color=grey
@part drone motors cylinder r=0.07 h=0.1 at=0.53,0.06,0.53 around=4 mat=steel
@part drone props box w=0.6 h=0.01 d=0.06 at=0.53,0.14,0.53 around=4 mat=plastic color=white
@tag drone motors "Motors" left
@tag drone props "Propellers" right
A drone is a light body with four arms, each with a motor and a propeller.
@part drone camera sphere r=0.1 at=0,-0.12,0.25 mat=glass
@part drone battery box w=0.3 h=0.08 d=0.4 at=0,0.13,0 mat=paint color=blue
@part drone legs capsule r=0.02 h=0.3 at=0.2,-0.2,0.2 around=4 mat=plastic
@tag drone camera "Camera" left
@tag drone battery "Battery" right
Each motor spins its propeller to push air down.
@move drone props spin axis=y amount=360 period=0.3
Spinning the propellers at different speeds tilts and steers it.
` },
]
