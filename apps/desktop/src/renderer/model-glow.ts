import * as THREE from 'three'

const FULLSCREEN = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
/** Nine-tap Gaussian along one direction; run twice (across, then down) for a round blur. */
const BLUR = `uniform sampler2D source; uniform vec2 step; varying vec2 vUv;
void main() {
  vec4 sum = texture2D(source, vUv) * 0.2270270;
  sum += (texture2D(source, vUv + step * 1.3846154) + texture2D(source, vUv - step * 1.3846154)) * 0.3162162;
  sum += (texture2D(source, vUv + step * 3.2307692) + texture2D(source, vUv - step * 3.2307692)) * 0.0702703;
  gl_FragColor = sum;
}`
/** Light adds to whatever is underneath, and the halo's own alpha lets it show over a transparent canvas. */
const COMPOSITE = `uniform sampler2D source; uniform float strength; varying vec2 vUv;
void main() { vec3 glow = texture2D(source, vUv).rgb * strength; gl_FragColor = vec4(glow, max(glow.r, max(glow.g, glow.b))); }`

function emits(material: THREE.MeshStandardMaterial): boolean {
  return !!material.emissive && material.emissiveIntensity > 0 && material.emissive.getHex() !== 0
}

/** Glow for parts that give off light (designed emission, or the glow material): only they shine,
 *  so a lit exhaust or reactor blooms without washing out the paper or the rest of the model.
 *  Each frame the lit parts are drawn alone into a small buffer, everything else as black so it
 *  still hides what is behind it, then blurred and added on top of the finished frame. */
export class GlowPass {
  private readonly targets = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true }))
  private readonly blur = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN, fragmentShader: BLUR, uniforms: { source: { value: null }, step: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false })
  private readonly composite = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN, fragmentShader: COMPOSITE, uniforms: { source: { value: null }, strength: { value: 1.1 } },
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  })
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blur)
  private readonly screen = new THREE.Scene()
  private readonly view = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  /** A stand-in per material: lit by its emission, or black where it only blocks light. Each keeps
   *  its own material's clipping planes, as a cut opens some parts and leaves later ones whole. */
  private readonly stands = new Map<THREE.Material, THREE.MeshBasicMaterial>()
  private readonly meshes: THREE.Mesh[] = []
  private readonly swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = []
  private width = 1
  private height = 1

  constructor() { this.screen.add(this.quad) }

  /** The glow buffer is a quarter of the canvas on each side: blur hides the low resolution. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width / 4)); this.height = Math.max(1, Math.round(height / 4))
    for (const target of this.targets) target.setSize(this.width, this.height)
  }

  /** Adds the glow onto the frame just rendered; does nothing when no part gives off light. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    let glowing = false
    scene.traverseVisible((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || !mesh.layers.isEnabled(0) || Array.isArray(mesh.material)) return
      this.meshes.push(mesh); glowing ||= emits(mesh.material as THREE.MeshStandardMaterial)
    })
    // Most models give off no light: then nothing is swapped and no pass runs.
    if (glowing) for (const mesh of this.meshes) {
      const material = mesh.material as THREE.MeshStandardMaterial
      this.swapped.push([mesh, material])
      if (material.transparent && !emits(material)) { mesh.visible = false; continue }
      let stand = this.stands.get(material)
      if (!stand) {
        stand = new THREE.MeshBasicMaterial({ color: emits(material) ? material.emissive.clone().multiplyScalar(material.emissiveIntensity) : 0 })
        this.stands.set(material, stand)
      }
      // A cutaway opens the glow buffer exactly as it opens the model.
      stand.clippingPlanes = material.clippingPlanes
      mesh.material = stand
    }
    this.meshes.length = 0
    if (glowing) {
      const mask = camera.layers.mask, autoClear = renderer.autoClear, background = scene.background
      // Only the solid parts: ink outlines, the ground and section caps stay out of the glow.
      camera.layers.set(0); scene.background = null
      renderer.setRenderTarget(this.targets[0]!); renderer.setClearColor(0, 0); renderer.clear()
      renderer.render(scene, camera)
      camera.layers.mask = mask; scene.background = background
      this.restore()
      this.quad.material = this.blur
      for (let pass = 0; pass < 2; pass++) for (const [from, to, x, y] of [[0, 1, 1, 0], [1, 0, 0, 1]] as const) {
        this.blur.uniforms.source!.value = this.targets[from]!.texture
        ;(this.blur.uniforms.step!.value as THREE.Vector2).set(x / this.width * (pass + 1), y / this.height * (pass + 1))
        renderer.setRenderTarget(this.targets[to]!); renderer.render(this.screen, this.view)
      }
      renderer.setRenderTarget(null); renderer.autoClear = false
      this.quad.material = this.composite; this.composite.uniforms.source!.value = this.targets[0]!.texture
      renderer.render(this.screen, this.view)
      renderer.autoClear = autoClear
    }
  }

  /** Frees the stand-in of a material that is gone, as when a polish pass removes a part. */
  forget(material: THREE.Material): void {
    this.stands.get(material)?.dispose(); this.stands.delete(material)
  }

  private restore(): void {
    for (const [mesh, material] of this.swapped) { mesh.material = material; mesh.visible = true }
    this.swapped.length = 0
  }

  dispose(): void {
    for (const target of this.targets) target.dispose()
    for (const material of [this.blur, this.composite, ...this.stands.values()]) material.dispose()
    this.quad.geometry.dispose(); this.stands.clear()
  }
}
