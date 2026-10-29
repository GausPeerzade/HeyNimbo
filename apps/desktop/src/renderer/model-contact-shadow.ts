import * as THREE from 'three'
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js'
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js'

const SIZE = 256

/** A soft grounding shadow: the model's underside rendered from below as
 *  darkness by height, then blurred twice. Technique adapted from three.js
 *  examples/webgl_shadow_contact (MIT); sizing and the update policy are ours.
 *  Renders only layer 0, which holds the parts' solid meshes. */
export class ContactShadow {
  readonly group = new THREE.Group()
  private readonly target = new THREE.WebGLRenderTarget(SIZE, SIZE)
  private readonly blurTarget = new THREE.WebGLRenderTarget(SIZE, SIZE)
  private readonly camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1)
  private readonly geometry = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2)
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly blurPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly depth = new THREE.MeshDepthMaterial({ depthTest: false, depthWrite: false })
  private readonly horizontal = new THREE.ShaderMaterial({ ...HorizontalBlurShader, uniforms: THREE.UniformsUtils.clone(HorizontalBlurShader.uniforms), depthTest: false })
  private readonly vertical = new THREE.ShaderMaterial({ ...VerticalBlurShader, uniforms: THREE.UniformsUtils.clone(VerticalBlurShader.uniforms), depthTest: false })

  constructor(private readonly blur = 3.2) {
    this.target.texture.generateMipmaps = false; this.blurTarget.texture.generateMipmaps = false
    // The rotated plane faces down, so it is drawn double-sided; its uv then
    // lines up with the upward camera's image without a flip.
    this.plane = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ map: this.target.texture, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide }))
    this.plane.renderOrder = 1; this.plane.layers.set(1)
    this.blurPlane = new THREE.Mesh(this.geometry, this.horizontal)
    this.blurPlane.visible = false
    this.camera.rotation.x = Math.PI / 2
    this.depth.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * 1.25 );')
    }
    this.group.add(this.plane, this.blurPlane, this.camera)
  }

  /** Spreads the catcher under a footprint; only parts within `height` of the ground darken it. */
  place(x: number, y: number, z: number, width: number, depth: number, height: number): void {
    this.group.position.set(x, y, z)
    this.plane.scale.set(width, 1, depth); this.blurPlane.scale.set(width, 1, depth)
    Object.assign(this.camera, { left: -width / 2, right: width / 2, top: depth / 2, bottom: -depth / 2, far: height })
    this.camera.updateProjectionMatrix()
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const previous = renderer.getRenderTarget(), clearAlpha = renderer.getClearAlpha(), override = scene.overrideMaterial
    this.plane.visible = false
    scene.overrideMaterial = this.depth
    renderer.setClearAlpha(0)
    renderer.setRenderTarget(this.target); renderer.clear(); renderer.render(scene, this.camera)
    scene.overrideMaterial = override
    this.blurPass(renderer, this.blur); this.blurPass(renderer, this.blur * 0.4)
    renderer.setRenderTarget(previous); renderer.setClearAlpha(clearAlpha)
    this.plane.visible = true
  }

  private blurPass(renderer: THREE.WebGLRenderer, amount: number): void {
    this.blurPlane.visible = true
    this.blurPlane.material = this.horizontal; this.horizontal.uniforms.tDiffuse!.value = this.target.texture; this.horizontal.uniforms.h!.value = amount / SIZE
    renderer.setRenderTarget(this.blurTarget); renderer.render(this.blurPlane, this.camera)
    this.blurPlane.material = this.vertical; this.vertical.uniforms.tDiffuse!.value = this.blurTarget.texture; this.vertical.uniforms.v!.value = amount / SIZE
    renderer.setRenderTarget(this.target); renderer.render(this.blurPlane, this.camera)
    this.blurPlane.visible = false
  }

  /** Every material this pass renders with, so their shaders can compile ahead of the first use. */
  get materials(): THREE.Material[] { return [this.depth, this.horizontal, this.vertical] }

  dispose(): void {
    this.target.dispose(); this.blurTarget.dispose(); this.geometry.dispose()
    this.plane.material.dispose(); this.depth.dispose(); this.horizontal.dispose(); this.vertical.dispose()
    this.group.removeFromParent()
  }
}
