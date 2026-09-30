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

float lmCurve(float l) { return l / (4.0 - 3.0 * l); }
vec3 lightmap(float sky, float blk) {
  float s = lmCurve(clamp(sky, 0.0, 1.0)) * uSkyBright;
  float b = lmCurve(clamp(blk, 0.0, 1.0)) * uFlicker;
  vec3 c = s * uSkyLightColor + b * vec3(1.0, 0.84, 0.64);
  c = clamp(c, vec3(0.0), vec3(1.0));
  c = mix(c, vec3(1.0) - pow(vec3(1.0) - c, vec3(4.0)), uGamma);
  return max(c, uAmbient);
}
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

export const CHUNK_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in uvec4 aData;
uniform mat4 uViewProj;
uniform vec3 uOffset;
uniform vec3 uChunkPos;
uniform float uTime;
uniform float uAnim;
uniform float uAnimSlow;
out vec3 vUV;
out vec3 vLight;
out vec3 vTint;
out vec3 vRel;
flat out uint vFlags;
void main() {
  uint w0 = aData.x, w1 = aData.y, w2 = aData.z, w3 = aData.w;
  vec3 p = vec3(float(w0 & 511u), float((w0 >> 9u) & 8191u), float((w0 >> 22u) & 511u)) * 0.0625;
  uint flags = (w1 >> 22u) & 1023u;
  vec3 wp = uChunkPos + p;
  if ((flags & 1u) != 0u) {
    p.x += sin(uTime * 1.7 + wp.x * 0.9 + wp.y * 0.5) * 0.02;
    p.z += cos(uTime * 1.4 + wp.z * 0.8 + wp.y * 0.6) * 0.02;
  } else if ((flags & 2u) != 0u) {
    p.x += sin(uTime * 2.1 + wp.x * 0.7 + wp.z * 0.4) * 0.065;
    p.z += cos(uTime * 1.8 + wp.z * 0.6 + wp.x * 0.3) * 0.045;
  }
  float layer = float((w1 >> 10u) & 511u);
  if ((flags & 4u) != 0u) layer += uAnim;
  else if ((flags & 8u) != 0u) layer += uAnimSlow;
  vUV = vec3(float(w1 & 31u) * 0.0625, float((w1 >> 5u) & 31u) * 0.0625, layer);
  vLight = vec3(float(w2 & 255u), float((w2 >> 8u) & 255u), float((w2 >> 16u) & 255u)) / 255.0;
  vTint = vec3(float(w3 & 255u), float((w3 >> 8u) & 255u), float((w3 >> 16u) & 255u)) / 255.0;
  vFlags = flags;
  vec3 rel = uOffset + p;
  vRel = rel;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

export const CHUNK_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform int uPass;
${COMMON}
in vec3 vUV;
in vec3 vLight;
in vec3 vTint;
in vec3 vRel;
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
  vec3 L = (vFlags & 16u) != 0u ? vec3(1.0) : lightmap(vLight.x, vLight.y);
  col *= L * vLight.z;
  float f = fogFactor(vRel);
  col = mix(col, fogColorFor(normalize(vRel)), f);
  outColor = vec4(col, alpha);
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
  col = mix(col, sunCol * 1.25, disc * sunVis);
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
      vec3 moon = vec3(0.92, 0.93, 0.98) * (1.0 - mare) * (0.08 + 0.92 * lit);
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
out vec3 vUV;
out vec3 vNormal;
out vec3 vRel;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vRel = wp.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vUV = aUV;
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
${COMMON}
in vec3 vUV;
in vec3 vNormal;
in vec3 vRel;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
  if (uMode == 1) { outColor = t; return; }
  vec3 base = t.rgb;
  float a = t.a;
  if (uBlockMode == 1) { base = t.rgb * mix(vec3(1.0), uTintColor, 1.0 - t.a); a = 1.0; }
  else if (uBlockMode >= 2) { base = t.rgb * uTintColor; if (uBlockMode == 2 && a < 0.5) discard; }
  if (a < 0.1) discard;
  vec3 n = normalize(vNormal);
  float shade = 0.58 + 0.34 * max(dot(n, normalize(vec3(0.25, 1.0, -0.45))), 0.0) + 0.14 * max(dot(n, normalize(vec3(-0.3, 0.6, 0.7))), 0.0);
  vec3 col = base * min(shade, 1.0) * lightmap(uLight.x, uLight.y);
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
  vec3 fc = fogColorFor(normalize(vRel));
  col = mix(col, fc, smoothstep(uCloudFar * 0.3, uCloudFar, d) * 0.6);
  outColor = vec4(col, a);
}`;
