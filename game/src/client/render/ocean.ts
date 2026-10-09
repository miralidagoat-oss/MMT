/**
 * Ocean surface. The vertex shader evaluates exactly the same wave function as
 * shared/world/ocean.ts (so rafts and swimmers bob in sync with what you see).
 * The fragment shader does depth-based absorption, shore foam, sky reflection
 * (PMREM env), sun glitter, subsurface scattering and an underwater view.
 */
import * as THREE from 'three';
import { WAVES } from '../../shared/world/ocean';
import { textures } from './textures';

/** Radial grid: dense near the centre, sparse to the horizon. */
function radialGrid(rings: number, segs: number, maxR: number, quality: number): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  const radii: number[] = [];
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    radii.push(Math.pow(t, 2.6) * maxR + t * (quality >= 3 ? 0.6 : 1.2) * r * 0.5);
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    pos.push(Math.cos(a) * radii[r]!, 0, Math.sin(a) * radii[r]!);
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let r = 0; r < rings - 1; r++) for (let s = 0; s < segs; s++) {
    const a = 1 + r * segs + s, b = 1 + r * segs + ((s + 1) % segs);
    const c = a + segs, d = b + segs;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), maxR * 2);
  return g;
}

const waveGLSL = (() => {
  const lines = WAVES.map((w, i) => `
    { float dir = windDir + ${w.dirOffset.toFixed(4)};
      float k = ${(Math.PI * 2 / w.wavelength).toFixed(6)};
      float c = sqrt(9.81 / k) * ${w.speedMul.toFixed(3)};
      vec2 D = vec2(cos(dir), sin(dir));
      float ph = k * (dot(D, p) - c * t);
      float s01 = (sin(ph) + 1.0) * 0.5;
      float pw = pow(s01, ${w.sharp.toFixed(3)});
      h += (pw * 2.0 - 1.0) * ${w.amp.toFixed(4)};
      float dp = ${w.sharp.toFixed(3)} * pow(max(s01, 1e-4), ${(w.sharp - 1).toFixed(3)}) * cos(ph) * k * ${w.amp.toFixed(4)};
      grad += D * dp; }`).join('\n');
  return `
  // must match shared/world/ocean.ts waveHeight()
  float waveH(vec2 p, float t, float amp, float windDir, out vec2 grad) {
    float h = 0.0; grad = vec2(0.0);
    ${lines}
    grad *= amp;
    return h * amp;
  }`;
})();

export interface OceanUniforms { [k: string]: THREE.IUniform }

export class OceanSystem {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(heightTex: THREE.Texture, quality: number) {
    const t = textures();
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 }, amp: { value: 1 }, windDir: { value: 0 },
        tHeight: { value: heightTex }, heightCenter: { value: new THREE.Vector2() }, heightSpan: { value: 1536 },
        tNormal: { value: t.waterNormal }, tFoam: { value: t.foam },
        envMap: { value: null }, hasEnv: { value: 0 },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 1, 1) }, sunIntensity: { value: 1 },
        skyColor: { value: new THREE.Color(0.5, 0.7, 0.9) }, horizonColor: { value: new THREE.Color(0.7, 0.8, 0.9) },
        deepColor: { value: new THREE.Color(0.01, 0.09, 0.16) }, shallowColor: { value: new THREE.Color(0.07, 0.55, 0.55) },
        daylight: { value: 1 }, rain: { value: 0 }, detail: { value: quality },
        camPos: { value: new THREE.Vector3() },
        tReflect: { value: null }, reflMatrix: { value: new THREE.Matrix4() }, reflOn: { value: 0 },
      }]),
      vertexShader: `
        uniform float time, amp, windDir, heightSpan;
        uniform vec2 heightCenter; uniform sampler2D tHeight; uniform vec3 camPos;
        varying vec3 vWPos; varying vec2 vGrad; varying float vH; varying float vDepth;
        #include <fog_pars_vertex>
        ${waveGLSL}
        float terrainH(vec2 p){ vec2 uv = (p - heightCenter)/heightSpan + 0.5; if (uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0) return -40.0; return texture2D(tHeight, uv).r; }
        void main(){
          vec3 wp = position + vec3(camPos.x, 0.0, camPos.z);
          float ground = terrainH(wp.xz);
          float depth = -ground;
          float damp = depth <= 0.0 ? 0.15 : min(1.0, 0.15 + depth/6.0);
          vec2 g;
          float h = waveH(wp.xz, time, amp, windDir, g) * damp;
          wp.y = h;
          vGrad = g * damp; vH = h; vDepth = depth + h;
          vWPos = wp;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          vec4 mvPosition = mv;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform float time, amp, windDir, sunIntensity, daylight, rain, hasEnv, detail, heightSpan;
        uniform vec2 heightCenter;
        uniform sampler2D tNormal, tFoam, tHeight;
        uniform sampler2D envMap;
        uniform sampler2D tReflect; uniform mat4 reflMatrix; uniform float reflOn;
        uniform vec3 sunDir, sunColor, skyColor, horizonColor, deepColor, shallowColor, camPos;
        varying vec3 vWPos; varying vec2 vGrad; varying float vH; varying float vDepth;
        #include <common>
        #include <cube_uv_reflection_fragment>
        #include <fog_pars_fragment>
        float terrainH(vec2 p){ vec2 uv = (p - heightCenter)/heightSpan + 0.5; if (uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0) return -40.0; return texture2D(tHeight, uv).r; }
        // expanding rings where raindrops hit: returns a normal offset
        vec2 ripple(vec2 p, float t){
          vec2 cell = floor(p); vec2 f = fract(p) - 0.5;
          float hh = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
          vec2 off = (vec2(fract(hh * 13.7), fract(hh * 7.3)) - 0.5) * 0.45;
          float ph = fract(t * 0.85 + hh);
          vec2 d = f - off; float r = length(d);
          float ring = 0.5 * ph;
          float w = sin((r - ring) * 42.0) * (1.0 - ph) * smoothstep(ring + 0.07, ring, r) * smoothstep(0.0, 0.05, r);
          return d / max(r, 1e-3) * w;
        }
        vec3 skyRefl(vec3 r){
          ${'#ifdef ENVMAP_TYPE_CUBE_UV'}
          if (hasEnv > 0.5) return textureCubeUV(envMap, r, 0.06).rgb;
          ${'#endif'}
          return mix(horizonColor, skyColor, pow(max(r.y,0.0), 0.5));
        }
        void main(){
          vec3 V = normalize(cameraPosition - vWPos);
          float dist = length(cameraPosition - vWPos);
          // macro normal from analytic wave gradient + two scrolling detail normal maps
          vec3 N = normalize(vec3(-vGrad.x, 1.0, -vGrad.y));
          float detailFade = 1.0 - smoothstep(60.0, 600.0, dist);
          vec2 wdir = vec2(cos(windDir), sin(windDir));
          vec3 n1 = texture2D(tNormal, vWPos.xz*0.045 + wdir*time*0.018).xzy*2.0-1.0;
          vec3 n2 = texture2D(tNormal, vWPos.xz*0.11 - wdir.yx*time*0.03).xzy*2.0-1.0;
          vec3 n3 = texture2D(tNormal, vWPos.xz*0.6 + vec2(time*0.07, -time*0.05)).xzy*2.0-1.0;
          vec3 dn = (n1*0.6 + n2*0.4 + n3*0.35*rain) * (0.35 + amp*0.25) * detailFade;
          if (rain > 0.02 && dist < 45.0) {
            vec2 rp = (ripple(vWPos.xz * 1.7, time) + ripple(vWPos.xz * 1.7 + 17.3, time + 0.43)) * rain * (1.0 - dist / 45.0);
            dn.xz += rp * 0.5;
          }
          N = normalize(N + vec3(dn.x, 0.0, dn.z));
          bool under = !gl_FrontFacing;
          if (under) N = -N;
          float NdV = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
          float depth = max(vDepth, 0.0);
          vec3 col;
          if (!under) {
            vec3 R = reflect(-V, N); R.y = abs(R.y);
            vec3 refl = skyRefl(R);
            if (reflOn > 0.5) {
              // planar reflection of islands, trees, boats and the sky, rippled by the waves
              vec4 rc = reflMatrix * vec4(vWPos.x, 0.0, vWPos.z, 1.0);
              vec2 ruv = rc.xy / rc.w;
              float near = 1.0 / (1.0 + dist * 0.015);
              ruv += (dn.xz * 0.07 + vGrad * 0.035) * (0.35 + 0.65 * near);
              vec3 planar = texture2D(tReflect, clamp(ruv, vec2(0.002), vec2(0.998))).rgb;
              // fade to the probe at the frame edges where the mirror has no data
              float edge = smoothstep(0.0, 0.04, ruv.x) * smoothstep(1.0, 0.96, ruv.x) * smoothstep(0.0, 0.04, ruv.y) * smoothstep(1.0, 0.96, ruv.y);
              refl = mix(refl, planar, edge * reflOn);
            }
            // water body: absorption by depth, shallows show the sand
            float absorb = 1.0 - exp(-depth * 0.16);
            vec3 body = mix(shallowColor * (0.6 + 0.4*daylight), deepColor * (0.3 + 0.7*daylight), absorb);
            float sandShow = exp(-depth * 0.7);
            body = mix(body, vec3(0.75,0.7,0.55) * (0.5+0.5*daylight), sandShow * 0.55);
            // subsurface scattering on wave crests facing away from sun
            float sss = pow(max(dot(V, -sunDir), 0.0), 3.0) * max(vH + 0.3, 0.0) * 0.45;
            body += shallowColor * sss * sunIntensity * daylight;
            col = mix(body, refl, fres);
            // sun specular + glitter
            vec3 H = normalize(sunDir + V);
            float spec = pow(max(dot(N, H), 0.0), 900.0) * 18.0 + pow(max(dot(N, H), 0.0), 120.0) * 0.6;
            col += sunColor * spec * sunIntensity * step(0.0, sunDir.y);
            // foam: shoreline and wave crests
            float shore = smoothstep(1.4, 0.0, depth) * smoothstep(-0.2, 0.2, depth + 0.3);
            float crest = smoothstep(0.45, 1.0, vH / max(amp, 0.3)) * smoothstep(1.0, 2.2, amp);
            float foamTex = texture2D(tFoam, vWPos.xz*0.12 + wdir*time*0.05).r;
            float band = 0.5 + 0.5*sin(depth*7.0 - time*1.8);
            float foam = clamp(shore * (foamTex*1.4 + band*0.4) + crest * foamTex * 1.5, 0.0, 1.0);
            col = mix(col, vec3(0.92,0.95,0.95) * (0.35 + 0.65*daylight), foam * detailFade);
            float alpha = mix(0.55, 1.0, smoothstep(0.0, 4.0, depth));
            alpha = max(alpha, fres);
            alpha = max(alpha, foam);
            gl_FragColor = vec4(col, alpha);
          } else {
            // looking up from below: Snell's window (the refracted sky, ~97 deg cone),
            // total internal reflection of the deep water everywhere else
            float window = smoothstep(0.64, 0.74, NdV);
            vec3 Tr = refract(-V, -N, 1.33);
            vec3 above = mix(horizonColor, skyColor, clamp(Tr.y, 0.0, 1.0)) * (0.35 + 0.75*daylight);
            // the sun seen through the rippling surface
            float sunSpot = pow(max(dot(normalize(Tr + vec3(0.0, 1e-3, 0.0)), sunDir), 0.0), 60.0);
            above += sunColor * sunSpot * 4.0 * sunIntensity * step(0.0, sunDir.y);
            // bright rim at the edge of the window
            float rim = smoothstep(0.6, 0.66, NdV) * (1.0 - smoothstep(0.66, 0.76, NdV));
            vec3 tir = deepColor * (0.3 + 0.7*daylight) * 1.3 + shallowColor * 0.08 * daylight;
            col = mix(tir, above, window) + shallowColor * rim * 0.35 * daylight;
            gl_FragColor = vec4(col, 1.0);
          }
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      side: THREE.DoubleSide,
      fog: true,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(radialGrid(quality >= 3 ? 220 : quality >= 2 ? 160 : 100, quality >= 3 ? 256 : quality >= 2 ? 192 : 128, 7000, quality), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  setEnv(tex: THREE.Texture | null): void {
    const u = this.material.uniforms;
    u.envMap!.value = tex;
    u.hasEnv!.value = tex ? 1 : 0;
    if (tex) {
      const img = (tex as THREE.Texture & { image: { height: number } }).image;
      this.material.defines = { ENVMAP_TYPE_CUBE_UV: '', ...cubeUVDefines(img?.height ?? 256) };
      this.material.needsUpdate = true;
    }
  }
}

/** Defines required by three's cube_uv_reflection_fragment chunk for PMREM textures. */
function cubeUVDefines(imageHeight: number): Record<string, string> {
  const maxMip = Math.log2(imageHeight) - 2;
  const texelHeight = 1.0 / imageHeight;
  const texelWidth = 1.0 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
  return { CUBEUV_TEXEL_WIDTH: texelWidth.toFixed(8), CUBEUV_TEXEL_HEIGHT: texelHeight.toFixed(8), CUBEUV_MAX_MIP: `${maxMip.toFixed(1)}` };
}
