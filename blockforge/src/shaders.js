// GLSL sources for the renderer.

const COMMON = `
uniform float uSkyBright;
uniform vec3 uSkyLightColor;
uniform float uGamma;
uniform float uFlicker;
uniform vec3 uFogColor;
uniform vec4 uSunset;
uniform vec3 uSunDir;
uniform vec3 uFog; // start, end, mode (0 normal, 1 underwater, 2 lava)
uniform vec3 uAmbient;
uniform float uEmissive; // above 1 when drawing to an HDR target, so lights glow through bloom

float lmCurve(float l) { return l / (4.0 - 3.0 * l); }
vec3 lightmapS(float sky, float blk, float skyMul) {
  float s = lmCurve(clamp(sky, 0.0, 1.0)) * uSkyBright * skyMul;
  float b = lmCurve(clamp(blk, 0.0, 1.0)) * uFlicker;
  vec3 c = s * uSkyLightColor + b * vec3(1.0, 0.84, 0.64);
  c = clamp(c, vec3(0.0), vec3(1.0));
  c = mix(c, vec3(1.0) - pow(vec3(1.0) - c, vec3(4.0)), uGamma);
  return max(c, uAmbient);
}
vec3 lightmap(float sky, float blk) { return lightmapS(sky, blk, 1.0); }
vec3 fogColorFor(vec3 dir) {
  if (uFog.z > 0.5) return uFogColor;
  vec2 dh = normalize(dir.xz + vec2(1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float s = pow(max(dot(dh, sh), 0.0), 4.0) * uSunset.a;
  return mix(uFogColor, uSunset.rgb, s * 0.85);
}
float fogFactor(vec3 rel) {
  float d = uFog.z > 0.5 ? length(rel) : max(length(rel.xz), abs(rel.y) * 0.7);
  float f = clamp((d - uFog.x) / max(uFog.y - uFog.x, 0.001), 0.0, 1.0);
  return uFog.z > 0.5 ? f : f * f * (3.0 - 2.0 * f);
}
`;

// Sun shadows: lookups into the shadow map drawn from the sun (or moon).
const SHADOW_FN = `
uniform highp sampler2DShadow uShadowMap;
uniform vec4 uShadowParams; // strength (0 = off), texel size in uv, texel size in blocks, taps (1 = 4, 2 = 9)
float shadowAt(vec3 sc) {
  if (sc.x <= 0.0 || sc.x >= 1.0 || sc.y <= 0.0 || sc.y >= 1.0 || sc.z >= 1.0) return 1.0;
  float ts = uShadowParams.y;
  float z = sc.z - 0.00035;
  float s;
  if (uShadowParams.w > 1.5) {
    s = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) s += texture(uShadowMap, vec3(sc.xy + vec2(float(i), float(j)) * ts * 1.2, z));
    s *= 1.0 / 9.0;
  } else {
    s = 0.25 * (texture(uShadowMap, vec3(sc.xy + vec2(-0.5, -0.5) * ts, z)) + texture(uShadowMap, vec3(sc.xy + vec2(0.5, -0.5) * ts, z)) +
      texture(uShadowMap, vec3(sc.xy + vec2(-0.5, 0.5) * ts, z)) + texture(uShadowMap, vec3(sc.xy + vec2(0.5, 0.5) * ts, z)));
  }
  vec2 e = abs(sc.xy - 0.5) * 2.0;
  return mix(s, 1.0, smoothstep(0.82, 0.98, max(e.x, e.y)));
}
// Sky light multiplier: sunlit faces a touch brighter, shaded ones darker.
float sunMul(vec3 sc, float ndl) {
  if (uShadowParams.x <= 0.0) return 1.0;
  float lit = ndl > 0.0 ? shadowAt(sc) * smoothstep(0.0, 0.18, ndl) : 0.0;
  return 1.0 + uShadowParams.x * (0.1 * lit - 0.45 * (1.0 - lit));
}
`;

// Shared vertex decoding for chunk meshes (see mesher.js for the packing).
const CHUNK_DECODE = `
layout(location = 0) in uvec4 aData;
uniform vec3 uOffset;
uniform vec3 uChunkPos;
uniform float uTime;
uniform float uAnim;
uniform float uAnimSlow;
uniform float uWave;
const vec3 FACE_N[7] = vec3[7](vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0), vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0), vec3(0.0, 1.0, 0.0));
vec3 decodePos(out uint flags, out uint face, out vec3 world) {
  uint w0 = aData.x, w1 = aData.y;
  vec3 p = vec3(float(w0 & 511u), float((w0 >> 9u) & 8191u), float((w0 >> 22u) & 511u)) * 0.0625;
  flags = (w1 >> 22u) & 1023u;
  face = (w1 >> 19u) & 7u;
  vec3 wp = uChunkPos + p;
  world = wp;
  if ((flags & 1u) != 0u) {
    p.x += sin(uTime * 1.7 + wp.x * 0.9 + wp.y * 0.5) * 0.02 * uWave;
    p.z += cos(uTime * 1.4 + wp.z * 0.8 + wp.y * 0.6) * 0.02 * uWave;
  } else if ((flags & 2u) != 0u) {
    p.x += sin(uTime * 2.1 + wp.x * 0.7 + wp.z * 0.4) * 0.065 * uWave;
    p.z += cos(uTime * 1.8 + wp.z * 0.6 + wp.x * 0.3) * 0.045 * uWave;
  }
  return uOffset + p;
}
vec3 decodeUV(uint flags) {
  uint w1 = aData.y;
  float layer = float((w1 >> 10u) & 511u);
  if ((flags & 4u) != 0u) layer += uAnim;
  else if ((flags & 8u) != 0u) layer += uAnimSlow;
  return vec3(float(w1 & 31u) * 0.0625, float((w1 >> 5u) & 31u) * 0.0625, layer);
}
`;

export const CHUNK_VS = `#version 300 es
precision highp float;
precision highp int;
${CHUNK_DECODE}
uniform mat4 uViewProj;
uniform mat4 uShadowVP;
uniform vec3 uLightDir;
uniform vec4 uShadowParams;
out vec3 vUV;
out vec3 vLight;
out vec3 vTint;
out vec3 vRel;
out vec3 vWorld;
out vec3 vShadow;
out float vNdl;
flat out uint vFlags;
void main() {
  uint flags, face;
  vec3 world;
  vec3 rel = decodePos(flags, face, world);
  vUV = decodeUV(flags);
  uint w2 = aData.z, w3 = aData.w;
  vLight = vec3(float(w2 & 255u), float((w2 >> 8u) & 255u), float((w2 >> 16u) & 255u)) / 255.0;
  vTint = vec3(float(w3 & 255u), float((w3 >> 8u) & 255u), float((w3 >> 16u) & 255u)) / 255.0;
  vFlags = flags | (face << 16u);
  vRel = rel;
  vWorld = world;
  vec3 n = FACE_N[face];
  vNdl = face == 6u ? 0.6 : dot(n, uLightDir);
  if (uShadowParams.x > 0.0) {
    // pushed out along the normal by about a texel so surfaces don't shadow themselves
    vec4 sc = uShadowVP * vec4(rel + (face == 6u ? uLightDir : n) * uShadowParams.z * 1.4, 1.0);
    vShadow = sc.xyz * 0.5 + 0.5;
  } else vShadow = vec3(0.5);
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

export const CHUNK_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform int uPass;
uniform vec3 uZenith;
uniform float uRain;
uniform float uTime;
uniform float uWaterFx;
${COMMON}
${SHADOW_FN}
in vec3 vUV;
in vec3 vLight;
in vec3 vTint;
in vec3 vRel;
in vec3 vWorld;
in vec3 vShadow;
in float vNdl;
flat in uint vFlags;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
  vec3 col;
  float alpha = 1.0;
  if (uPass == 1) {
    if (t.a < 0.5) discard;
    col = t.rgb * vTint;
  } else if (uPass == 2) {
    col = t.rgb * vTint;
    alpha = t.a;
  } else {
    col = t.rgb * mix(vec3(1.0), vTint, 1.0 - t.a);
  }
  uint face = (vFlags >> 16u) & 7u;
  float sm = vLight.x > 0.02 ? sunMul(vShadow, vNdl) : 1.0;
  bool selfLit = (vFlags & 16u) != 0u;
  vec3 L = selfLit ? vec3(1.0) : lightmapS(vLight.x, vLight.y, sm);
  col *= L * vLight.z;
  if (selfLit || (vFlags & 64u) != 0u) col *= uEmissive;
  // water: rippled sky reflection and a glint of sun
  if ((vFlags & 32u) != 0u && uWaterFx > 0.5 && face == 0u && uFog.z < 0.5) {
    vec2 wp = vWorld.xz;
    float tt = uTime;
    vec2 g = vec2(0.8, 0.6) * cos(dot(wp, vec2(0.8, 0.6)) * 1.3 + tt * 1.6) * 0.06
      + vec2(-0.5, 0.86) * cos(dot(wp, vec2(-0.5, 0.86)) * 2.1 + tt * 2.3) * 0.04
      + vec2(0.3, -0.95) * cos(dot(wp, vec2(0.3, -0.95)) * 3.7 + tt * 3.1) * 0.025
      + vec2(-0.9, -0.4) * cos(dot(wp, vec2(-0.9, -0.4)) * 6.3 + tt * 4.3) * 0.014;
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 V = normalize(-vRel);
    vec3 R = reflect(-V, n);
    R.y = abs(R.y);
    float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    float open = lmCurve(vLight.x);
    vec3 refl = mix(fogColorFor(R), uZenith, smoothstep(0.0, 0.55, R.y)) * (0.35 + 0.65 * uSkyBright);
    col = mix(col, refl, clamp(fres * 0.92 * open, 0.0, 1.0));
    alpha = mix(alpha, 1.0, fres * 0.75 * open);
    float sunVis = smoothstep(-0.04, 0.12, uSunDir.y) * (1.0 - uRain) * open * (uShadowParams.x > 0.0 ? shadowAt(vShadow) : 1.0);
    float spec = pow(max(dot(R, uSunDir), 0.0), 260.0) * sunVis;
    col += vec3(1.0, 0.94, 0.82) * spec * 2.2 * uEmissive;
    alpha = max(alpha, min(1.0, spec * 1.5));
  }
  float f = fogFactor(vRel);
  col = mix(col, fogColorFor(normalize(vRel)), f);
  outColor = vec4(col, alpha);
}`;

// Depth-only pass from the sun for shadow mapping.
export const SHADOW_VS = `#version 300 es
precision highp float;
precision highp int;
${CHUNK_DECODE}
uniform mat4 uLightVP;
out vec3 vUV;
void main() {
  uint flags, face;
  vec3 world;
  vec3 rel = decodePos(flags, face, world);
  vUV = decodeUV(flags);
  gl_Position = uLightVP * vec4(rel, 1.0);
}`;

export const SHADOW_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform int uPass;
in vec3 vUV;
out vec4 outColor;
void main() {
  if (uPass == 1 && texture(uTex, vUV).a < 0.5) discard;
  outColor = vec4(1.0);
}`;

export const SKY_VS = `#version 300 es
out vec2 vPos;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vPos = p;
  gl_Position = vec4(p, 0.9999, 1.0);
}`;

export const SKY_FS = `#version 300 es
precision highp float;
uniform mat4 uInvViewProj;
uniform vec3 uZenith;
uniform float uStars;
uniform float uMoonPhase;
uniform float uTime;
uniform float uRain;
uniform float uDay;
uniform mat3 uCelestial;
uniform float uSkyMode;
${COMMON}
in vec2 vPos;
out vec4 outColor;
float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec4 p = uInvViewProj * vec4(vPos, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w);
  float h = dir.y;
  vec3 horizon = fogColorFor(dir);
  vec3 col = mix(horizon, uZenith, smoothstep(0.0, 0.5, h));
  col = mix(col, horizon * 0.72, smoothstep(0.0, -0.4, h));
  if (uFog.z > 0.5) { outColor = vec4(uFogColor, 1.0); return; }
  if (uSkyMode > 0.5) {
    // the Void: a dark violet gradient, drifting haze and stars in every direction
    vec3 c = mix(vec3(0.02, 0.01, 0.035), vec3(0.07, 0.035, 0.1), smoothstep(-0.7, 0.7, h));
    float neb = (0.5 + 0.5 * sin(dir.x * 6.0 + uTime * 0.015) * sin(dir.z * 5.0 - dir.y * 3.0 + uTime * 0.01)) * (0.5 + 0.5 * sin(dir.y * 9.0 + dir.x * 4.0));
    c += vec3(0.09, 0.03, 0.15) * pow(neb, 3.0) + vec3(0.02, 0.05, 0.08) * pow(1.0 - abs(h), 6.0);
    vec3 g = dir * 150.0;
    vec3 cell = floor(g);
    float hs = hash(cell);
    if (hs > 0.993) {
      float d = length(g - cell - 0.5);
      float tw = 0.7 + 0.3 * sin(uTime * (1.0 + hs * 20.0) + hs * 200.0);
      c += mix(vec3(0.8, 0.85, 1.0), vec3(0.85, 0.7, 1.0), hash(cell + 3.0)) * smoothstep(0.6, 0.05, d) * tw * uEmissive;
    }
    outColor = vec4(mix(c, uFogColor, 0.15), 1.0);
    return;
  }
  // stars rotate with the sky
  if (uStars > 0.01) {
    vec3 sd = uCelestial * dir;
    vec3 g = sd * 170.0;
    vec3 cell = floor(g);
    float hs = hash(cell);
    if (hs > 0.9955) {
      vec3 c = cell + 0.5;
      float d = length(g - c);
      float tw = 0.75 + 0.25 * sin(uTime * (2.0 + hs * 40.0) + hs * 300.0);
      float b = smoothstep(0.62, 0.05, d) * uStars * tw * (0.45 + 0.55 * hash(cell + 7.1));
      col += vec3(0.95, 0.97, 1.0) * b * smoothstep(-0.05, 0.12, h) * (1.0 - uRain);
    }
  }
  // sun: soft corona and bright disc
  float cs = dot(dir, uSunDir);
  float sunVis = (1.0 - uRain * 0.9) * smoothstep(-0.12, 0.02, uSunDir.y + 0.1);
  vec3 sunCol = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.97, 0.86), smoothstep(-0.05, 0.3, uSunDir.y));
  col += sunCol * (pow(max(cs, 0.0), 900.0) * 0.8 + pow(max(cs, 0.0), 60.0) * 0.18 + pow(max(cs, 0.0), 8.0) * 0.06 * uDay) * sunVis;
  float disc = smoothstep(0.99905, 0.99925, cs);
  col = mix(col, sunCol * 1.25 * (1.0 + (uEmissive - 1.0) * 5.0), disc * sunVis);
  // moon with phase shading and a few maria
  vec3 md = -uSunDir;
  float cm = dot(dir, md);
  if (cm > 0.9990) {
    vec3 up = abs(md.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 ax = normalize(cross(up, md)), ay = cross(md, ax);
    vec2 q = vec2(dot(dir, ax), dot(dir, ay)) / 0.0435;
    float r = length(q);
    if (r < 1.0) {
      float z = sqrt(1.0 - r * r);
      vec3 n = vec3(q, z);
      float ph = uMoonPhase * 6.2831853;
      vec3 lightDir = normalize(vec3(sin(ph), 0.0, -cos(ph)));
      float lit = smoothstep(-0.06, 0.06, dot(n, lightDir));
      float mare = smoothstep(0.35, 0.2, length(q - vec2(-0.3, 0.25))) * 0.25 + smoothstep(0.3, 0.15, length(q - vec2(0.35, -0.2))) * 0.2 + smoothstep(0.2, 0.1, length(q - vec2(0.1, 0.45))) * 0.15;
      vec3 moon = vec3(0.92, 0.93, 0.98) * (1.0 - mare) * (0.08 + 0.92 * lit) * (1.0 + (uEmissive - 1.0) * 0.8);
      float edge = smoothstep(1.0, 0.94, r);
      col = mix(col, max(col, moon), edge * (1.0 - uRain * 0.9));
    }
  }
  if (cm > 0.99) col += vec3(0.6, 0.65, 0.8) * pow(max(cm, 0.0), 2000.0) * 0.25 * (1.0 - uDay);
  outColor = vec4(col, 1.0);
}`;

export const MODEL_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aUV;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat4 uShadowVP;
uniform vec4 uShadowParams;
out vec3 vUV;
out vec3 vNormal;
out vec3 vRel;
out vec3 vShadow;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vRel = wp.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vUV = aUV;
  if (uShadowParams.x > 0.0) {
    vec4 sc = uShadowVP * vec4(wp.xyz + vNormal * uShadowParams.z * 1.4, 1.0);
    vShadow = sc.xyz * 0.5 + 0.5;
  } else vShadow = vec3(0.5);
  gl_Position = uViewProj * wp;
}`;

export const MODEL_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform vec2 uLight;
uniform vec4 uTint;
uniform int uMode;      // 0 lit + fog, 1 unlit overlay, 2 lit without fog (hand)
uniform int uBlockMode; // 0 alpha is transparency, 1 opaque block (alpha = tint mask), 2 cutout block, 3 translucent block
uniform vec3 uTintColor;
uniform float uAlpha;
uniform vec3 uLightDir;
uniform float uGlow;
${COMMON}
${SHADOW_FN}
in vec3 vUV;
in vec3 vNormal;
in vec3 vRel;
in vec3 vShadow;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
  if (uMode == 1) { outColor = vec4(t.rgb * mix(1.0, uEmissive, uGlow), t.a * uAlpha); return; }
  vec3 base = t.rgb;
  float a = t.a;
  if (uBlockMode == 1) { base = t.rgb * mix(vec3(1.0), uTintColor, 1.0 - t.a); a = 1.0; }
  else if (uBlockMode >= 2) { base = t.rgb * uTintColor; if (uBlockMode == 2 && a < 0.5) discard; }
  if (a < 0.1) discard;
  vec3 n = normalize(vNormal);
  float shade = 0.58 + 0.34 * max(dot(n, normalize(vec3(0.25, 1.0, -0.45))), 0.0) + 0.14 * max(dot(n, normalize(vec3(-0.3, 0.6, 0.7))), 0.0);
  float sm = uMode == 0 && uLight.x > 0.02 ? sunMul(vShadow, dot(n, uLightDir) * 0.5 + 0.5) : 1.0;
  vec3 col = base * min(shade, 1.0) * lightmapS(uLight.x, uLight.y, sm);
  col = mix(col, uTint.rgb, uTint.a);
  if (uMode == 0) col = mix(col, fogColorFor(normalize(vRel)), fogFactor(vRel));
  outColor = vec4(col, uAlpha * (uBlockMode == 1 || uBlockMode == 2 ? 1.0 : a));
}`;

export const PARTICLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aUV;
layout(location = 2) in vec4 aColor;
uniform mat4 uViewProj;
out vec3 vUV;
out vec4 vColor;
out vec3 vRel;
void main() {
  vUV = aUV; vColor = aColor; vRel = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
${COMMON}
in vec3 vUV;
in vec4 vColor;
in vec3 vRel;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
  if (t.a < 0.3) discard;
  vec3 col = t.rgb * vColor.rgb;
  col = mix(col, fogColorFor(normalize(vRel)), fogFactor(vRel));
  outColor = vec4(col, t.a * vColor.a);
}`;

export const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;

export const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

export const CLOUD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aShade;
uniform mat4 uViewProj;
uniform vec3 uOffset;
out float vShade;
out vec3 vRel;
void main() {
  vec3 rel = aPos + uOffset;
  vRel = rel; vShade = aShade;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

export const CLOUD_FS = `#version 300 es
precision highp float;
uniform vec3 uCloudColor;
uniform float uCloudFar;
${COMMON}
in float vShade;
in vec3 vRel;
out vec4 outColor;
void main() {
  float d = length(vRel.xz);
  float a = 0.82 * (1.0 - smoothstep(uCloudFar * 0.55, uCloudFar, d));
  if (a <= 0.003) discard;
  vec3 col = uCloudColor * vShade;
  // a silver lining toward the sun
  vec3 dir = normalize(vRel);
  col += uSunset.rgb * uSunset.a * 0.25 * pow(max(dot(dir, uSunDir), 0.0), 6.0);
  vec3 fc = fogColorFor(dir);
  col = mix(col, fc, smoothstep(uCloudFar * 0.3, uCloudFar, d) * 0.6);
  outColor = vec4(col, a);
}`;

// ---------------------------------------------------------------------------
// Post-processing: bloom, tone mapping, colour grading and FXAA.
export const POST_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// First bloom step: keep only what is brighter than the threshold (soft knee),
// weighted down so single bright pixels don't flicker.
export const BLOOM_PRE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uThreshold; // threshold, knee
in vec2 vUV;
out vec4 outColor;
vec3 pick(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold.x + uThreshold.y, 0.0, 2.0 * uThreshold.y);
  soft = soft * soft / (4.0 * uThreshold.y + 1e-4);
  float w = max(soft, br - uThreshold.x) / max(br, 1e-4);
  return c * w / (1.0 + br * 0.25);
}
void main() {
  vec3 c = pick(vUV + uTexel * vec2(-0.5, -0.5)) + pick(vUV + uTexel * vec2(0.5, -0.5))
    + pick(vUV + uTexel * vec2(-0.5, 0.5)) + pick(vUV + uTexel * vec2(0.5, 0.5));
  outColor = vec4(c * 0.25, 1.0);
}`;

// 13-tap downsample.
export const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 outColor;
vec3 s(vec2 o) { return texture(uSrc, vUV + o * uTexel).rgb; }
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  outColor = vec4(col, 1.0);
}`;

// 9-tap tent upsample, added onto the next larger level.
export const BLOOM_UP_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 outColor;
vec3 s(vec2 o) { return texture(uSrc, vUV + o * uTexel).rgb; }
void main() {
  vec3 col = s(vec2(0.0)) * 4.0
    + (s(vec2(-1.0, 0.0)) + s(vec2(1.0, 0.0)) + s(vec2(0.0, -1.0)) + s(vec2(0.0, 1.0))) * 2.0
    + s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0));
  outColor = vec4(col / 16.0, 1.0);
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomAmt;
uniform float uGrade;
uniform float uFxaaLuma;
in vec2 vUV;
out vec4 outColor;
// Leaves everything up to 0.72 alone and rolls brighter values smoothly into 1.
vec3 shoulder(vec3 x) {
  const float a = 0.72;
  vec3 hi = a + (1.0 - a) * (1.0 - exp(-(x - a) / (1.0 - a)));
  return mix(x, hi, step(vec3(a), x));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  if (uBloomAmt > 0.0) c += texture(uBloom, vUV).rgb * uBloomAmt;
  c = shoulder(max(c, 0.0));
  if (uGrade > 0.5) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.07);
    c = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
    vec2 d = vUV - 0.5;
    c *= 1.0 - dot(d, d) * 0.42;
  }
  c = clamp(c, 0.0, 1.0);
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(c, uFxaaLuma > 0.5 ? dot(c, vec3(0.299, 0.587, 0.114)) : 1.0);
}`;

export const FXAA_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec4 m = texture(uSrc, vUV);
  float lM = m.a;
  float lNW = texture(uSrc, vUV + vec2(-1.0, -1.0) * uTexel).a;
  float lNE = texture(uSrc, vUV + vec2(1.0, -1.0) * uTexel).a;
  float lSW = texture(uSrc, vUV + vec2(-1.0, 1.0) * uTexel).a;
  float lSE = texture(uSrc, vUV + vec2(1.0, 1.0) * uTexel).a;
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.05, lMax * 0.16)) { outColor = vec4(m.rgb, 1.0); return; }
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture(uSrc, vUV + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uSrc, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uSrc, vUV - dir * 0.5).rgb + texture(uSrc, vUV + dir * 0.5).rgb);
  float lB = dot(b, vec3(0.299, 0.587, 0.114));
  outColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}`;
