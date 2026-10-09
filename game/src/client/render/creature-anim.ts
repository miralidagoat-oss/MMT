/**
 * Animal animation in the vertex shader. Each creature model is one merged
 * mesh, so the motion is a per-species deformation of model space
 * (+z forward, +y up): fish and sharks sweep their tails, rays flap,
 * gulls beat their wings, crabs scuttle, boars swing their legs and snakes
 * slither. `animT` is the creature's animation clock (it runs faster when the
 * animal moves) and `animMove` is 0 at rest .. 1 at full speed.
 */
import * as THREE from 'three';

const DEFORM: Record<string, string> = {
  shark: `{
    float k = clamp(-transformed.z / 2.3, 0.0, 1.0);
    transformed.x += sin(animT * 2.2 - transformed.z * 1.2) * 0.38 * k * k * (0.45 + 0.55 * animMove);
  }`,
  fish: `{
    float k = clamp((0.05 - transformed.z) / 0.4, 0.0, 1.0);
    transformed.x += sin(animT * 9.0 - transformed.z * 8.0) * 0.09 * k * k * (0.5 + 0.5 * animMove);
  }`,
  ray: `{
    float ax = abs(transformed.x);
    transformed.y += sin(animT * 2.4 - ax * 1.6) * 0.2 * ax;
    float tail = max(0.0, -transformed.z - 0.6);
    transformed.x += sin(animT * 3.0 + transformed.z) * 0.12 * tail;
  }`,
  gull: `{
    float ax = abs(transformed.x);
    float wing = smoothstep(0.08, 0.75, ax);
    transformed.y += sin(animT * 7.0) * 0.36 * wing * ax;
  }`,
  crab: `{
    float leg = step(0.18, abs(transformed.x)) * step(transformed.y, 0.16);
    float side = sign(transformed.x);
    transformed.y += abs(sin(animT * 9.0 + transformed.z * 22.0 + side * 1.57)) * 0.045 * leg * animMove;
    transformed.z += sin(animT * 9.0 + transformed.z * 22.0 + side * 1.57) * 0.03 * leg * animMove;
  }`,
  boar: `{
    float low = clamp((0.42 - transformed.y) / 0.42, 0.0, 1.0);
    float diag = sign(transformed.x) * sign(transformed.z) > 0.0 ? 0.0 : 3.14159;
    float isLeg = step(0.12, abs(transformed.x)) * step(0.2, abs(transformed.z)) * step(transformed.y, 0.42);
    transformed.z += sin(animT * 3.2 + diag) * 0.16 * low * isLeg * animMove;
    // tail flick and head bob
    transformed.y += sin(animT * 1.6) * 0.02 * step(0.55, transformed.z);
  }`,
  snake: `{
    transformed.x += sin(animT * 3.0 + transformed.z * 7.0) * 0.07 * (0.3 + 0.7 * animMove);
  }`,
};

export interface CreatureAnim { mat: THREE.MeshStandardMaterial; t: { value: number }; move: { value: number } }

/** A per-creature material (shared shader program per species, own uniforms). */
export function creatureMaterial(kind: string): CreatureAnim {
  const t = { value: 0 }, move = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'shark' || kind === 'fish' || kind === 'ray' ? 0.45 : 0.8 });
  const code = DEFORM[kind];
  if (code) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.animT = t;
      shader.uniforms.animMove = move;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float animT; uniform float animMove;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${code}`);
    };
    mat.customProgramCacheKey = () => `creature-${kind}`;
  }
  return { mat, t, move };
}
