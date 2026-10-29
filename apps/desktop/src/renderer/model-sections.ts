import * as THREE from 'three'
import type { Axis } from '../shared/model-protocol'
import type { ModelPart } from './model-geometry'

interface SectionCopy {
  reveal: THREE.Group
  stencil: THREE.Mesh[]
  cap: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
}

/** Stencil winding/cap pass adapted from three.js webgl_clipping_stencil (MIT).
 *  The section hatch and per-part/repeat lifecycle are our own. */
export class ModelSections {
  readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
  private axis?: Axis | 'view'
  private readonly center = new THREE.Vector3()
  private readonly copies: SectionCopy[] = []
  private readonly surfaces = new Set<THREE.Material>()
  private readonly materials = new Set<THREE.Material>()
  private readonly geometry = new THREE.PlaneGeometry(1, 1)
  constructor(private readonly scene: THREE.Scene) {}

  register(part: ModelPart, surface: THREE.MeshStandardMaterial, outline: THREE.LineBasicMaterial): void {
    this.surfaces.add(surface); this.surfaces.add(outline)
    if (this.axis) { surface.clippingPlanes = [this.plane]; outline.clippingPlanes = [this.plane] }
    for (const reveal of part.reveals) {
      const order = this.copies.length * 3
      const stencil = [THREE.BackSide, THREE.FrontSide].map((side, i) => {
        const operation = i === 0 ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp
        const material = new THREE.MeshBasicMaterial({
          side, depthWrite: false, depthTest: false, colorWrite: false, clippingPlanes: [this.plane],
          stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
          stencilFail: operation, stencilZFail: operation, stencilZPass: operation,
        })
        this.materials.add(material)
        const mesh = new THREE.Mesh(part.geometry, material)
        mesh.renderOrder = order; mesh.visible = this.axis !== undefined; reveal.add(mesh)
        return mesh
      })
      const material = new THREE.ShaderMaterial({
        side: THREE.DoubleSide, uniforms: {
          span: { value: 1 }, paper: { value: new THREE.Color(0xd8b993).lerp(surface.color, surface.metalness > 0.5 ? 0.25 : 0.65) }, ink: { value: new THREE.Color(0x776549) },
        },
        vertexShader: 'varying vec2 sectionUv; void main() { sectionUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec2 sectionUv; uniform float span; uniform vec3 paper; uniform vec3 ink;
          void main() {
            vec2 p = sectionUv * span;
            float diagonal = (p.x + 0.6 * p.y) * 12.0;
            float line = 1.0 - smoothstep(0.035, 0.035 + fwidth(diagonal), abs(fract(diagonal) - 0.5));
            float dash = step(0.25, fract((p.y - 0.6 * p.x) * 7.0));
            gl_FragColor = vec4(mix(paper, ink, line * (0.65 + 0.35 * dash)), 1.0);
            #include <colorspace_fragment>
          }`,
        stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      })
      this.materials.add(material)
      const cap = new THREE.Mesh(this.geometry, material)
      cap.renderOrder = order + 1; cap.visible = false
      cap.onAfterRender = (renderer) => renderer.clearStencil()
      this.scene.add(cap); this.copies.push({ reveal, stencil, cap })
      for (const mesh of reveal.children) if (!stencil.some((pass) => pass === mesh)) mesh.renderOrder = 1000
    }
  }

  cut(axis: Axis | 'view', center = new THREE.Vector3()): void {
    this.axis = axis; this.center.copy(center)
    for (const surface of this.surfaces) { surface.clippingPlanes = [this.plane]; surface.needsUpdate = true }
    for (const copy of this.copies) for (const mesh of copy.stencil) mesh.visible = true
  }

  update(camera: THREE.Camera, bounds: THREE.Sphere): void {
    if (!this.axis) return
    const normal = this.axis === 'view' ? camera.getWorldDirection(new THREE.Vector3())
      : new THREE.Vector3(this.axis === 'x' ? -1 : 0, this.axis === 'y' ? -1 : 0, this.axis === 'z' ? -1 : 0)
    this.plane.setFromNormalAndCoplanarPoint(normal, this.axis === 'view' ? this.center : new THREE.Vector3())
    const center = this.plane.projectPoint(bounds.center, new THREE.Vector3())
    const span = Math.max(0.1, bounds.radius * 2.2)
    for (const { cap, reveal } of this.copies) {
      cap.visible = reveal.visible
      cap.position.copy(center); cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
      cap.scale.setScalar(span); cap.material.uniforms.span!.value = span
    }
  }

  dispose(): void {
    for (const copy of this.copies) { copy.cap.removeFromParent(); for (const stencil of copy.stencil) stencil.removeFromParent() }
    for (const material of this.materials) material.dispose()
    this.geometry.dispose(); this.copies.length = 0; this.surfaces.clear(); this.materials.clear()
  }
}
