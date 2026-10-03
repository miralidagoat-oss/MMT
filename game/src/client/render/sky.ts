/**
 * Sky, sun/moon lighting, stars, clouds, fog and the reflection environment.
 * A custom analytic sky (art-directed palettes keyed on sun elevation) keeps
 * radiance in a controlled HDR range so bloom/tone mapping behave, and gives
 * proper golden hour, sunset, twilight and moonlit nights.
 * Driven every frame by authoritative time-of-day and weather from the session.
 */
import * as THREE from 'three';
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

/** Palette keyframes by sun elevation (sunDir.y). Linear-space colours. */
const PALETTE: { e: number; zenith: [number, number, number]; horizon: [number, number, number]; sun: [number, number, number] }[] = [
  { e: -0.35, zenith: [0.004, 0.007, 0.02], horizon: [0.014, 0.022, 0.045], sun: [0.5, 0.6, 0.9] },
  { e: -0.16, zenith: [0.012, 0.02, 0.06], horizon: [0.06, 0.05, 0.1], sun: [0.6, 0.55, 0.8] },
  { e: -0.05, zenith: [0.04, 0.07, 0.2], horizon: [0.55, 0.22, 0.14], sun: [1.0, 0.35, 0.15] },
  { e: 0.04, zenith: [0.1, 0.18, 0.42], horizon: [0.95, 0.5, 0.26], sun: [1.0, 0.52, 0.25] },
  { e: 0.14, zenith: [0.13, 0.28, 0.62], horizon: [0.92, 0.66, 0.42], sun: [1.0, 0.7, 0.42] },
  { e: 0.27, zenith: [0.13, 0.32, 0.72], horizon: [0.72, 0.68, 0.62], sun: [1.0, 0.84, 0.64] },
  { e: 0.45, zenith: [0.12, 0.33, 0.78], horizon: [0.5, 0.66, 0.84], sun: [1.0, 0.94, 0.85] },
  { e: 1.0, zenith: [0.1, 0.3, 0.75], horizon: [0.46, 0.63, 0.82], sun: [1.0, 0.97, 0.92] },
];

function samplePalette(e: number, out: { zenith: THREE.Color; horizon: THREE.Color; sun: THREE.Color }) {
  const p = PALETTE;
  let i = 0;
  while (i < p.length - 2 && e > p[i + 1]!.e) i++;
  const a = p[i]!, b = p[i + 1]!;
  const t = THREE.MathUtils.clamp((e - a.e) / (b.e - a.e), 0, 1);
  const s = t * t * (3 - 2 * t);
  const mix = (x: [number, number, number], y: [number, number, number], c: THREE.Color) => c.setRGB(x[0] + (y[0] - x[0]) * s, x[1] + (y[1] - x[1]) * s, x[2] + (y[2] - x[2]) * s);
  mix(a.zenith, b.zenith, out.zenith);
  mix(a.horizon, b.horizon, out.horizon);
  mix(a.sun, b.sun, out.sun);
}

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = `
  uniform vec3 zenith, horizon, sunDir, sunColor, moonDir; uniform float overcast, sunSize, moonGlow, night;
  varying vec3 vDir;
  void main(){
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = clamp(h, 0.0, 1.0);
    vec3 col = mix(horizon, zenith, pow(up, 0.42));
    // below the horizon: fade to a darker sea-haze tone
    col = mix(col, horizon * 0.55, clamp(-h * 5.0, 0.0, 1.0));
    float sd = max(dot(d, sunDir), 0.0);
    // warm forward scattering, strongest near the horizon at low sun
    float band = exp(-abs(h) * 5.0);
    col += sunColor * (pow(sd, 5.0) * 0.35 * band + pow(sd, 32.0) * 0.4) * (1.0 - overcast * 0.7);
    // sun disk + tight halo (controlled HDR so bloom picks it up, not the whole sky)
    float disk = sunSize > 0.0 ? smoothstep(1.0 - sunSize * 1.15, 1.0 - sunSize, sd) : 0.0;
    col += sunColor * (disk * 14.0 + pow(sd, 900.0) * 3.0 * step(0.0, sunSize)) * (1.0 - overcast * 0.92) * step(-0.04, sunDir.y);
    // moon glow at night
    float md = max(dot(d, moonDir), 0.0);
    col += vec3(0.55, 0.62, 0.8) * pow(md, 200.0) * 0.25 * moonGlow * night;
    // overcast flattens everything toward grey
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(lum) * vec3(0.95, 0.97, 1.0), overcast * 0.75);
    gl_FragColor = vec4(col, 1.0);
  }`;

const tmp = new THREE.Vector3();

export class SkySystem {
  sky: THREE.Mesh;
  skyMat: THREE.ShaderMaterial;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  stars: THREE.Points;
  moon: THREE.Mesh;
  clouds: THREE.Mesh;
  cloudMat: THREE.ShaderMaterial;
  fog: THREE.FogExp2;
  sunDir = new THREE.Vector3(0, 1, 0);
  moonDir = new THREE.Vector3(0, 1, 0);
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
  private probeMat: THREE.ShaderMaterial;
  envMap: THREE.Texture | null = null;
  shadowSize = 2048;
  private pal = { zenith: new THREE.Color(), horizon: new THREE.Color(), sun: new THREE.Color() };

  constructor(private scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    const skyUniforms = () => ({
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() }, moonDir: { value: new THREE.Vector3(0, 1, 0) }, overcast: { value: 0 }, sunSize: { value: 0.00012 },
      moonGlow: { value: 1 }, night: { value: 0 },
    });
    this.skyMat = new THREE.ShaderMaterial({ uniforms: skyUniforms(), vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9500, 48, 24), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfdfff, 0x6b5a40, 0.4);
    scene.add(this.hemi);

    // stars
    const starGeo = new THREE.BufferGeometry();
    const n = 2600;
    const pos = new Float32Array(n * 3), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const th = 2 * Math.PI * Math.random(), ph = Math.acos(2 * Math.random() - 1);
      tmp.setFromSphericalCoords(9000, ph, th);
      if (tmp.y < 0) tmp.y = -tmp.y;
      pos.set([tmp.x, tmp.y, tmp.z], i * 3);
      size[i] = Math.random() ** 3 * 2.6 + 0.7;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 }, time: { value: 0 } },
      vertexShader: `attribute float size; varying float vTw; uniform float time;
        void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*mv; gl_PointSize = size; vTw = 0.7+0.3*sin(time*2.0+position.x*0.01); gl_Position.z = gl_Position.w*0.9999; }`,
      fragmentShader: `uniform float opacity; varying float vTw; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor = vec4(vec3(1.0,0.97,0.9)*vTw*1.4, opacity*(1.0-d*2.0)); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    scene.add(this.stars);

    this.moon = new THREE.Mesh(new THREE.SphereGeometry(55, 24, 16), new THREE.MeshBasicMaterial({ color: 0xdfe6f0, fog: false }));
    this.moon.renderOrder = -8;
    scene.add(this.moon);

    // cloud dome
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        tNoise: { value: textures().cloudNoise }, time: { value: 0 }, coverage: { value: 0.3 }, sunDir: { value: new THREE.Vector3() },
        sunColor: { value: new THREE.Color() }, skyColor: { value: new THREE.Color() }, darkness: { value: 0 }, windOff: { value: new THREE.Vector2() },
        brightness: { value: 1 },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position = p.xyww; }`,
      fragmentShader: `uniform sampler2D tNoise; uniform float time, coverage, darkness, brightness; uniform vec3 sunDir, sunColor, skyColor; uniform vec2 windOff; varying vec3 vDir;
        float layer(vec2 uv){ vec4 a = texture2D(tNoise, uv); vec4 b = texture2D(tNoise, uv*2.7+0.31); return a.r*0.55+a.g*0.25+b.b*0.2+b.r*0.12; }
        void main(){
          if (vDir.y < 0.0) discard;
          vec2 uv = vDir.xz/(vDir.y+0.12)*0.11 + windOff;
          float n = layer(uv);
          float c = smoothstep(1.0-coverage, 1.0-coverage+0.28, n);
          float thick = smoothstep(1.0-coverage, 1.15-coverage*0.5, layer(uv+sunDir.xz*0.025));
          float lit = clamp(1.0 - thick*0.85, 0.0, 1.0);
          vec3 base = skyColor * 1.05 + vec3(0.18) * brightness;
          vec3 col = base*mix(0.5,1.0,lit) + sunColor*lit*0.45*brightness;
          float silver = pow(max(dot(normalize(vDir), sunDir),0.0), 12.0)*(1.0-thick);
          col += sunColor*silver*0.9*brightness;
          col = mix(col, col*0.3, darkness);
          float horizonFade = smoothstep(0.0, 0.18, vDir.y);
          gl_FragColor = vec4(col, c*horizonFade*0.96);
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), this.cloudMat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -7;
    scene.add(this.clouds);

    this.fog = new THREE.FogExp2(0xa8c8e0, 0.0012);
    scene.fog = this.fog;

    // Reflection/ambient probe: the same sky without the sun disk.
    this.probeMat = new THREE.ShaderMaterial({ uniforms: skyUniforms(), vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false });
    this.probeMat.uniforms.sunSize!.value = -1;
    this.probeScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.probeMat));
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
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    this.moonDir.y = Math.max(0.2, this.moonDir.y);
    this.moonDir.normalize();
    const day = daylight(e.hour);
    this.daylight = day;
    const overcast = Math.min(1, e.cloud * 0.85 + e.rain * 0.45 + e.fog * 0.3);
    const elev = this.sunDir.y;
    const nightK = THREE.MathUtils.smoothstep(-elev, 0.02, 0.22); // 0 day .. 1 deep night

    samplePalette(elev, this.pal);
    this.zenithColor.copy(this.pal.zenith);
    this.horizonColor.copy(this.pal.horizon);
    this.sunColor.copy(this.pal.sun);
    // overcast skies are greyer and darker
    const grey = new THREE.Color(0.32, 0.34, 0.37).multiplyScalar(0.12 + 0.88 * Math.max(0, Math.min(1, elev * 3 + 0.3)));
    this.zenithColor.lerp(grey, overcast * 0.8);
    this.horizonColor.lerp(grey.clone().multiplyScalar(1.25), overcast * 0.75);
    if (e.lightning > 0) { this.zenithColor.addScalar(e.lightning * 0.5); this.horizonColor.addScalar(e.lightning * 0.6); }

    for (const m of [this.skyMat, this.probeMat]) {
      const u = m.uniforms;
      u.zenith!.value.copy(this.zenithColor);
      u.horizon!.value.copy(this.horizonColor);
      u.sunDir!.value.copy(this.sunDir);
      u.sunColor!.value.copy(this.sunColor);
      u.moonDir!.value.copy(this.moonDir);
      u.overcast!.value = overcast;
      u.night!.value = nightK;
    }

    // sun / moon light
    const sunUp = elev > -0.03;
    this.lightDir.copy(sunUp ? this.sunDir : this.moonDir);
    const camPos = (camera as THREE.PerspectiveCamera).position;
    const moonCol = new THREE.Color(0.5, 0.6, 0.95);
    const sunI = sunUp
      ? (0.2 + 3.1 * THREE.MathUtils.smoothstep(elev, -0.03, 0.3)) * (1 - overcast * 0.7)
      : 0.32 * (1 - overcast * 0.6);
    this.sun.color.copy(sunUp ? this.sunColor : moonCol);
    this.sun.intensity = sunI + e.lightning * 6;
    // snap shadow camera to texel grid to avoid shimmering
    const texel = (this.sun.shadow.camera.right * 2) / this.shadowSize;
    const cx = Math.round(camPos.x / texel) * texel, cz = Math.round(camPos.z / texel) * texel;
    this.sun.position.set(cx + this.lightDir.x * 300, camPos.y + this.lightDir.y * 300, cz + this.lightDir.z * 300);
    this.sun.target.position.set(cx, camPos.y, cz);
    this.sun.target.updateMatrixWorld();

    // ambient: sky-tinted by day, a readable blue moonlight floor at night
    const ambSky = this.zenithColor.clone().lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(1.4);
    const ambNight = new THREE.Color(0.1, 0.13, 0.24);
    this.hemi.color.copy(ambSky).lerp(ambNight, nightK);
    this.hemi.groundColor.setRGB(0.28, 0.24, 0.18).multiplyScalar(0.25 + day * 0.75);
    this.hemi.intensity = 0.25 + day * 0.3 + nightK * 0.35 + e.lightning * 2;

    // stars & moon
    const starsVis = THREE.MathUtils.smoothstep(-elev, 0.06, 0.25) * (1 - overcast);
    const sm = this.stars.material as THREE.ShaderMaterial;
    sm.uniforms.opacity!.value = starsVis * 0.95;
    sm.uniforms.time!.value = e.time;
    this.stars.position.copy(camPos);
    this.moon.position.copy(camPos).addScaledVector(this.moonDir, 2800);
    (this.moon.material as THREE.MeshBasicMaterial).color.setScalar((0.35 + nightK * 1.1) * (1 - overcast * 0.7));
    this.moon.visible = elev < 0.15;
    this.sky.position.copy(camPos);
    this.clouds.position.copy(camPos);

    // clouds
    const cu = this.cloudMat.uniforms;
    cu.time!.value = e.time;
    cu.coverage!.value = 0.16 + e.cloud * 0.74;
    cu.sunDir!.value.copy(this.lightDir);
    cu.sunColor!.value.copy(sunUp ? this.sunColor : moonCol).multiplyScalar(sunUp ? 1 : 0.12);
    cu.skyColor!.value.copy(this.horizonColor).lerp(this.zenithColor, 0.3);
    cu.brightness!.value = Math.max(0.04, day);
    cu.darkness!.value = Math.min(1, e.rain * 0.75);
    const wv = cu.windOff!.value as THREE.Vector2;
    wv.x += Math.cos(e.windDir) * (0.002 + e.wind * 0.01) * 0.016;
    wv.y += Math.sin(e.windDir) * (0.002 + e.wind * 0.01) * 0.016;

    // fog
    if (e.underwater) {
      this.fog.color.setRGB(0.02, 0.14, 0.17).multiplyScalar(0.25 + day * 0.75);
      this.fog.density = 0.045;
    } else {
      this.fog.color.copy(this.horizonColor).lerp(this.zenithColor, 0.25);
      this.fog.density = 0.0004 + e.fog * 0.008 + e.rain * 0.003;
    }
  }

  /** Rebuild the PBR environment map from the probe sky occasionally (expensive). */
  updateProbe(time: number, force = false): void {
    if (!force && time - this.lastProbe < 3) return;
    this.lastProbe = time;
    const rt = this.pmrem.fromScene(this.probeScene, 0, 0.1, 1000);
    this.envRT?.dispose();
    this.envRT = rt;
    this.envMap = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.6;
  }
}
