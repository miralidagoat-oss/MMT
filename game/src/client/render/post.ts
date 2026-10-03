/**
 * HDR post-processing chain:
 *   scene -> sceneRT (HDR, optional MSAA, depth texture)
 *   -> [GTAO] -> [bloom] -> grade (god rays, underwater, damage, vignette, color grading)
 *   -> output (ACES tone map + sRGB) -> [SMAA | FXAA]
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/examples/jsm/postprocessing/TexturePass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { GraphicsSettings } from '../settings';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    time: { value: 0 },
    underwater: { value: 0 },
    damage: { value: 0 },
    lowHealth: { value: 0 },
    flash: { value: 0 },
    brightness: { value: 1 },
    saturation: { value: 1.08 },
    vignette: { value: 0.32 },
    sunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    sunVisible: { value: 0 },
    sunColor: { value: new THREE.Color(1, 0.9, 0.7) },
    godRays: { value: 1 },
    cold: { value: 0 },
    sleep: { value: 0 },
    aspect: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse, tDepth; uniform float time, underwater, damage, lowHealth, flash, brightness, saturation, vignette, sunVisible, godRays, cold, sleep, aspect;
    uniform vec2 sunScreen; uniform vec3 sunColor; varying vec2 vUv;
    void main(){
      vec2 uv = vUv;
      if (underwater > 0.5) {
        uv += vec2(sin(uv.y*24.0 + time*1.7), cos(uv.x*19.0 + time*1.3)) * 0.0022;
      }
      vec3 col = texture2D(tDiffuse, uv).rgb;
      // god rays: radial march toward the sun accumulating sky (depth==1) samples
      if (godRays > 0.0 && sunVisible > 0.01) {
        vec2 d = (sunScreen - uv) / 36.0;
        vec2 p = uv; float acc = 0.0; float w = 1.0;
        for (int i = 0; i < 36; i++) {
          p += d;
          if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) break;
          float sky = step(0.99999, texture2D(tDepth, p).r);
          acc += sky * w; w *= 0.96;
        }
        acc /= 18.0;
        vec2 dd = (uv - sunScreen); dd.x *= aspect;
        float fall = exp(-length(dd) * 3.5);
        col += sunColor * acc * fall * sunVisible * godRays * 0.2 * (underwater > 0.5 ? 2.5 : 1.0);
      }
      if (underwater > 0.5) {
        col *= vec3(0.55, 0.85, 0.92);
        float y = smoothstep(0.0, 1.0, uv.y);
        col += vec3(0.02, 0.08, 0.1) * y;
      }
      col *= brightness;
      // saturation & subtle filmic contrast in linear HDR
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation - cold * 0.4);
      col = mix(col, col * vec3(0.85, 0.95, 1.15), cold);
      col += vec3(flash) * 0.9;
      vec2 vc = vUv - 0.5; vc.x *= aspect * 0.8;
      float v = smoothstep(0.85, 0.2, length(vc));
      col *= mix(1.0 - vignette, 1.0, v);
      float pulse = lowHealth * (0.55 + 0.45 * sin(time * 4.0));
      col = mix(col, vec3(0.5, 0.02, 0.0), (1.0 - v) * (damage * 0.8 + pulse * 0.6));
      col *= 1.0 - sleep;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class PostFX {
  composer: EffectComposer;
  sceneRT: THREE.WebGLRenderTarget;
  grade: ShaderPass;
  private texPass: TexturePass;
  private bloom: UnrealBloomPass | null = null;
  private ao: GTAOPass | null = null;
  private aa: SMAAPass | ShaderPass | null = null;
  private output: OutputPass;
  enabled = true;
  private w = 1;
  private h = 1;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1), samples: 0 });
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, rt);
    this.texPass = new TexturePass(this.sceneRT.texture);
    this.grade = new ShaderPass(GradeShader);
    this.output = new OutputPass();
  }

  configure(g: GraphicsSettings, w: number, h: number) {
    this.enabled = g.postProcessing;
    this.sceneRT.samples = g.antiAliasing === 'msaa' ? 4 : 0;
    // rebuild pass list
    for (const p of [...this.composer.passes]) this.composer.removePass(p);
    this.composer.addPass(this.texPass);
    this.ao?.dispose();
    this.ao = null;
    if (g.ambientOcclusion) {
      this.ao = new GTAOPass(this.scene, this.camera, w, h);
      this.ao.blendIntensity = 0.85;
      this.ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12 });
      this.composer.addPass(this.ao);
    }
    this.bloom?.dispose();
    this.bloom = null;
    if (g.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.5, 1.0);
      this.composer.addPass(this.bloom);
    }
    this.grade.uniforms.godRays!.value = g.godRays ? 1 : 0;
    this.grade.uniforms.brightness!.value = g.brightness;
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
    (this.aa as { dispose?: () => void } | null)?.dispose?.();
    this.aa = null;
    if (g.antiAliasing === 'smaa') this.aa = new SMAAPass();
    else if (g.antiAliasing === 'fxaa') this.aa = new ShaderPass(FXAAShader);
    if (this.aa) this.composer.addPass(this.aa);
    this.setSize(w, h);
  }

  setSize(w: number, h: number) {
    this.w = w; this.h = h;
    this.sceneRT.setSize(w, h);
    this.composer.setSize(w, h);
    if (this.aa instanceof ShaderPass) this.aa.uniforms.resolution!.value.set(1 / w, 1 / h);
    this.grade.uniforms.aspect!.value = w / h;
  }

  render(dt: number) {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      return;
    }
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);
    this.grade.uniforms.tDepth!.value = this.sceneRT.depthTexture;
    this.grade.uniforms.time!.value += dt;
    this.composer.render(dt);
  }

  get size() { return { w: this.w, h: this.h }; }
}
