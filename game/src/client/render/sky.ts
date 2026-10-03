/**
 * Sky, sun/moon lighting, stars, clouds, fog and the reflection environment.
 * Driven every frame by authoritative time-of-day and weather from the session.
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { daylight, sunDirection } from '../../shared/systems/weather';
import { textures } from './textures';

export interface EnvState {
  hour: number;
  cloud: number;
  rain: number;
  fog: number;
  wind: number;
  windDir: number;
  underwater: boolean;
  lightning: number; // 0..1 flash intensity
  time: number;
}

const tmp = new THREE.Vector3();

export class SkySystem {
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  stars: THREE.Points;
  moon: THREE.Mesh;
  clouds: THREE.Mesh;
  cloudMat: THREE.ShaderMaterial;
  fog: THREE.FogExp2;
  sunDir = new THREE.Vector3(0, 1, 0);
  /** direction the dominant light comes from (sun by day, moon by night) */
  lightDir = new THREE.Vector3(0, 1, 0);
  sunColor = new THREE.Color();
  horizonColor = new THREE.Color();
  zenithColor = new THREE.Color();
  daylight = 1;
  /** sky-only scene used to build reflection probes */
  probeScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastProbe = -1e9;
  private probeSky: Sky;
  private probeClouds: THREE.Mesh;
  envMap: THREE.Texture | null = null;
  shadowSize = 2048;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity!.value = 4;
    u.rayleigh!.value = 1.6;
    u.mieCoefficient!.value = 0.004;
    u.mieDirectionalG!.value = 0.86;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfdfff, 0x6b5a40, 0.6);
    scene.add(this.hemi);

    // stars
    const starGeo = new THREE.BufferGeometry();
    const n = 2500;
    const pos = new Float32Array(n * 3), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u1 = Math.random(), u2 = Math.random();
      const th = 2 * Math.PI * u1, ph = Math.acos(2 * u2 - 1);
      tmp.setFromSphericalCoords(9000, ph, th);
      if (tmp.y < -500) tmp.y = -tmp.y;
      pos.set([tmp.x, tmp.y, tmp.z], i * 3);
      size[i] = Math.random() ** 3 * 3 + 0.6;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 }, time: { value: 0 } },
      vertexShader: `attribute float size; varying float vTw; uniform float time;
        void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*mv; gl_PointSize = size; vTw = 0.7+0.3*sin(time*2.0+position.x*0.01); gl_Position.z = gl_Position.w*0.9999; }`,
      fragmentShader: `uniform float opacity; varying float vTw; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor = vec4(vec3(1.0,0.97,0.9)*vTw, opacity*(1.0-d*2.0)); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    this.moon = new THREE.Mesh(new THREE.SphereGeometry(160, 24, 16), new THREE.MeshBasicMaterial({ color: 0xdfe6f0, fog: false }));
    scene.add(this.moon);

    // cloud dome
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        tNoise: { value: textures().cloudNoise }, time: { value: 0 }, coverage: { value: 0.3 }, sunDir: { value: new THREE.Vector3() },
        sunColor: { value: new THREE.Color() }, skyColor: { value: new THREE.Color() }, darkness: { value: 0 }, windOff: { value: new THREE.Vector2() },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position = p; gl_Position.z = p.w*0.99995; }`,
      fragmentShader: `uniform sampler2D tNoise; uniform float time, coverage, darkness; uniform vec3 sunDir, sunColor, skyColor; uniform vec2 windOff; varying vec3 vDir;
        float layer(vec2 uv){ vec4 a = texture2D(tNoise, uv); vec4 b = texture2D(tNoise, uv*2.7+0.31); return a.r*0.55+a.g*0.25+b.b*0.2+b.r*0.12; }
        void main(){
          if (vDir.y < 0.0) discard;
          vec2 uv = vDir.xz/(vDir.y+0.12)*0.11 + windOff;
          float n = layer(uv);
          float c = smoothstep(1.0-coverage, 1.0-coverage+0.28, n);
          float thick = smoothstep(1.0-coverage, 1.15-coverage*0.5, layer(uv+sunDir.xz*0.025));
          float lit = clamp(1.0 - thick*0.85, 0.0, 1.0);
          vec3 base = mix(skyColor*1.1, vec3(1.0), 0.55);
          vec3 col = base*mix(0.45,1.0,lit) + sunColor*lit*0.35*max(0.0,sunDir.y+0.2);
          float silver = pow(max(dot(normalize(vDir), sunDir),0.0), 12.0)*(1.0-thick);
          col += sunColor*silver*0.8;
          col = mix(col, col*0.28, darkness);
          float horizonFade = smoothstep(0.0, 0.18, vDir.y);
          gl_FragColor = vec4(col, c*horizonFade*0.95);
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), this.cloudMat);
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);

    this.fog = new THREE.FogExp2(0xa8c8e0, 0.0012);
    scene.fog = this.fog;

    // reflection probe scene (sky + clouds only)
    this.probeSky = new Sky();
    this.probeSky.scale.setScalar(20000);
    this.probeScene.add(this.probeSky);
    this.probeClouds = new THREE.Mesh(this.clouds.geometry, this.cloudMat);
    this.probeScene.add(this.probeClouds);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  setShadowQuality(level: number): void {
    const size = [0, 1024, 2048, 3072, 4096][level] ?? 2048;
    this.sun.castShadow = level > 0;
    if (size && size !== this.shadowSize) {
      this.shadowSize = size;
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
    const ext = level >= 4 ? 90 : level >= 3 ? 75 : 60;
    const cam = this.sun.shadow.camera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 1; cam.far = 600;
    cam.updateProjectionMatrix();
  }

  update(e: EnvState, camera: THREE.Camera): void {
    const [sx, sy, sz] = sunDirection(e.hour);
    this.sunDir.set(sx, sy, sz).normalize();
    const day = daylight(e.hour);
    this.daylight = day;
    const overcast = Math.min(1, e.cloud * 0.9 + e.rain * 0.4);

    // sky shader
    const u = this.sky.material.uniforms;
    u.sunPosition!.value.copy(this.sunDir);
    u.turbidity!.value = 3 + overcast * 12 + e.fog * 6;
    u.rayleigh!.value = 1.2 + (1 - day) * 2 + overcast * 1.5;
    this.probeSky.material.uniforms.sunPosition!.value.copy(this.sunDir);
    this.probeSky.material.uniforms.turbidity!.value = u.turbidity!.value;
    this.probeSky.material.uniforms.rayleigh!.value = u.rayleigh!.value;

    // sun / moon light
    const moonDir = tmp.copy(this.sunDir).multiplyScalar(-1);
    if (moonDir.y < 0.15) moonDir.y = 0.15;
    moonDir.normalize();
    const sunUp = this.sunDir.y > -0.05;
    this.lightDir.copy(sunUp ? this.sunDir : moonDir);
    const warm = THREE.MathUtils.smoothstep(this.sunDir.y, -0.05, 0.35);
    this.sunColor.setRGB(1, 0.55 + warm * 0.42, 0.3 + warm * 0.62);
    const camPos = (camera as THREE.PerspectiveCamera).position;
    const lightCol = sunUp ? this.sunColor : new THREE.Color(0.55, 0.65, 0.95);
    const sunI = sunUp ? (0.25 + 3.2 * THREE.MathUtils.smoothstep(this.sunDir.y, -0.05, 0.25)) * (1 - overcast * 0.72) : 0.22 * (1 - overcast * 0.6);
    this.sun.color.copy(lightCol);
    this.sun.intensity = sunI + e.lightning * 6;
    // snap shadow camera to texel grid to avoid shimmering
    const texel = (this.sun.shadow.camera.right * 2) / this.shadowSize;
    const cx = Math.round(camPos.x / texel) * texel, cz = Math.round(camPos.z / texel) * texel;
    this.sun.position.set(cx + this.lightDir.x * 300, camPos.y + this.lightDir.y * 300, cz + this.lightDir.z * 300);
    this.sun.target.position.set(cx, camPos.y, cz);
    this.sun.target.updateMatrixWorld();

    // ambient
    this.zenithColor.setRGB(0.32, 0.52, 0.85).lerp(new THREE.Color(0.02, 0.03, 0.08), 1 - day).lerp(new THREE.Color(0.38, 0.4, 0.44).multiplyScalar(0.3 + day * 0.7), overcast * 0.8);
    this.horizonColor.setRGB(0.72, 0.8, 0.88).lerp(new THREE.Color(0.9, 0.55, 0.35), (1 - warm) * day * 0.8).lerp(new THREE.Color(0.03, 0.05, 0.1), 1 - day).lerp(new THREE.Color(0.5, 0.53, 0.56).multiplyScalar(0.25 + day * 0.75), overcast * 0.85);
    this.hemi.color.copy(this.zenithColor).multiplyScalar(1.4);
    this.hemi.groundColor.setRGB(0.32, 0.27, 0.2).multiplyScalar(0.25 + day * 0.75);
    this.hemi.intensity = 0.35 + day * 0.65 + e.lightning * 2;

    // stars & moon
    (this.stars.material as THREE.ShaderMaterial).uniforms.opacity!.value = (1 - day) * (1 - overcast) * 0.95;
    (this.stars.material as THREE.ShaderMaterial).uniforms.time!.value = e.time;
    this.stars.position.copy(camPos);
    this.moon.position.copy(camPos).addScaledVector(moonDir, 7000);
    (this.moon.material as THREE.MeshBasicMaterial).color.setScalar(0.4 + (1 - day) * 0.6 - overcast * 0.3);
    this.moon.visible = !sunUp || day < 0.6;
    this.sky.position.copy(camPos);
    this.clouds.position.copy(camPos);

    // clouds
    const cu = this.cloudMat.uniforms;
    cu.time!.value = e.time;
    cu.coverage!.value = 0.18 + e.cloud * 0.72;
    cu.sunDir!.value.copy(this.lightDir);
    cu.sunColor!.value.copy(lightCol).multiplyScalar(sunUp ? 1 : 0.25);
    cu.skyColor!.value.copy(this.horizonColor);
    cu.darkness!.value = Math.min(1, e.rain * 0.8 + (1 - day) * 0.75);
    const wv = cu.windOff!.value as THREE.Vector2;
    wv.x += Math.cos(e.windDir) * (0.002 + e.wind * 0.01) * 0.016;
    wv.y += Math.sin(e.windDir) * (0.002 + e.wind * 0.01) * 0.016;

    // fog
    if (e.underwater) {
      this.fog.color.setRGB(0.02, 0.16, 0.2).multiplyScalar(0.3 + day * 0.7);
      this.fog.density = 0.045;
    } else {
      this.fog.color.copy(this.horizonColor);
      this.fog.density = 0.00045 + e.fog * 0.008 + e.rain * 0.003;
    }
  }

  /** Rebuild the PBR environment map from the sky occasionally (expensive). */
  updateProbe(time: number, force = false): void {
    if (!force && time - this.lastProbe < 3) return;
    this.lastProbe = time;
    this.probeSky.position.set(0, 0, 0);
    this.probeClouds.position.set(0, 0, 0);
    const rt = this.pmrem.fromScene(this.probeScene, 0, 1, 20000);
    this.envRT?.dispose();
    this.envRT = rt;
    this.envMap = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.35 + this.daylight * 0.65;
  }
}
