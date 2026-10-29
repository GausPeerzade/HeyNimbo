import { parseMark, type Mark } from '../shared/beats'

/** Original, silent mechanism. Local commands exercise the same validator. */
export function pumpDemo(width: number, height: number): Array<{ durationMs: number; marks: Mark[] }> {
  const x = Math.round(width * 0.05), y = Math.round(height * 0.1)
  const w = Math.round(width * 0.49), h = Math.round(height * 0.75)
  const blocks: Array<[number, string[]]> = [
    [1200, [`@model pump ${x} ${y} ${w} ${h} "Inside a bicycle pump" turntable=true`, `@card pressure ${Math.round(width * 0.59)} ${y + 30} ${Math.round(width * 0.36)} 390 "Air on the move" grid`, '@heading pressure "Small pushes, high pressure"']],
    [3200, [
      '@part pump foot box w=1.8 h=0.18 d=0.95 round=0.07 at=0,-1.65,-0.5 mat=plastic color=blue',
      '@part pump bolts cylinder r=0.09 h=0.06 at=-0.65,-1.53,-0.5 copies=2 step=1.3,0,0 mat=steel',
      '@part pump barrel tube r=0.48 inner=0.39 h=2.7 at=0,-0.15,-0.3 mat=steel',
      '@part pump collar tube r=0.52 inner=0.39 h=0.14 at=0,1.27,0 in=barrel mat=brass',
      '@part pump base lathe profile=0.5,-0.1;0.54,-0.06;0.54,0.06;0.48,0.1 at=0,-1.48,-0.3 mat=steel',
      '@cut pump z', '@tag pump barrel "Air chamber" left',
    ]],
    [1800, ['@part pump rod cylinder r=0.065 h=2 at=0,1.05,-0.3 mat=steel', '@tag pump rod "Plunger rod" right']],
    [2800, [
      '@part pump piston cylinder r=0.375 h=0.2 at=0,-0.8,0 in=rod mat=brass',
      '@part pump seals torus r=0.35 tube=0.035 at=0,-0.86,0 copies=2 step=0,0.13,0 in=rod mat=rubber',
      '@part pump boss lathe profile=0.12,-0.08;0.12,0.04;0.08,0.08 at=0,-0.62,0 in=rod mat=steel',
      '@tag pump seals "Seal rings" right', '@step pressure "Seals trap the air" down purple',
    ]],
    [2200, [
      '@part pump handle capsule r=0.095 h=1.5 turn=0,0,90 at=0,1.05,0 in=rod mat=steel',
      '@part pump grips capsule r=0.14 h=0.48 turn=0,0,90 at=-0.55,1.05,0 copies=2 step=1.1,0,0 in=rod mat=rubber',
      '@tag pump handle "T-handle" right',
    ]],
    [2800, [
      '@part pump hose pipe points=0.42,-1.4,-0.36;0.9,-1.5,-0.38;1.3,-1,-0.35;1.55,-1.1,-0.35;1.55,-1.4,-0.35 r=0.065 mat=rubber',
      '@part pump nozzle capsule r=0.1 h=0.32 at=1.55,-1.42,-0.35 mat=brass',
      '@part pump tip cylinder r=0.07 h=0.18 at=1.55,-1.65,-0.35 mat=steel',
      '@tag pump nozzle "Hose nozzle" right', '@step pressure "Hose carries air out" right blue',
    ]],
    [2200, [
      '@part pump gauge cylinder r=0.25 h=0.12 turn=90,0,0 at=0.66,-1.2,-0.48 mat=brass',
      '@part pump dial cylinder r=0.215 h=0.012 at=0,0.07,0 in=gauge mat=paper',
      '@part pump ticks box w=0.014 h=0.012 d=0.04 at=0,0.082,0.165 around=8 in=gauge mat=rubber',
      '@part pump needle box w=0.025 h=0.014 d=0.15 at=0,0.09,0.065 turn=0,-35,0 in=gauge mat=plastic color=red',
      '@tag pump gauge "Pressure gauge" left',
    ]],
    [2300, ['@move pump rod slide axis=y amount=-0.75 period=3.5', '@step pressure "Push to compress" down orange', '@note pressure "The plunger and seals move together."']],
  ]
  return blocks.map(([durationMs, lines]) => ({ durationMs, marks: lines.map((line) => {
    const mark = parseMark(line, { width, height })
    if (!mark) throw new Error(`Invalid pump demo command: ${line}`)
    return mark
  }) }))
}
