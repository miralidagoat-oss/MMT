/** Procedural flame: two crossed additive cards animated in the shader (torches, fires). */
import * as THREE from 'three';

export function makeFlameMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, lean: { value: 0 } },
  vertexShader: `varying vec2 vUv; varying float vPh; uniform float lean; void main(){ vUv = uv; vPh = modelMatrix[3].x * 1.31 + modelMatrix[3].z * 0.73; vec3 p = position; p.x += lean * uv.y * uv.y * 0.12; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
  fragmentShader: `varying vec2 vUv; varying float vPh; uniform float time;
    #define T (time + vPh)
    float n2(vec2 p){ return sin(p.x * 7.1 + T * 9.0) * 0.5 + sin(p.y * 11.3 - T * 13.0 + p.x * 3.0) * 0.35 + sin((p.x + p.y) * 17.0 - T * 21.0) * 0.15; }
    void main(){
      float v = vUv.y;
      float x = vUv.x - 0.5;
      // tongue-shaped silhouette that flickers and narrows upwards
      x += n2(vec2(v * 1.3, v * 2.0)) * 0.07 * v;
      float width = 0.36 * pow(1.0 - v, 0.75) * (0.85 + 0.15 * sin(T * 17.0 + v * 6.0));
      float body = smoothstep(width, width * 0.25, abs(x)) * smoothstep(0.0, 0.08, v) * smoothstep(1.0, 0.55, v + n2(vec2(x * 4.0, v)) * 0.08);
      float core = smoothstep(width * 0.55, 0.0, abs(x)) * smoothstep(0.62, 0.05, v);
      vec3 outer = vec3(1.0, 0.32, 0.05);
      vec3 mid = vec3(1.0, 0.62, 0.18);
      vec3 hot = vec3(1.0, 0.92, 0.7);
      vec3 col = mix(outer, mid, smoothstep(0.2, 0.7, body)) ;
      col = mix(col, hot, core);
      float a = body * (0.75 + core * 0.25);
      if (a < 0.01) discard;
      gl_FragColor = vec4(col * (1.4 + core * 1.6) * a, a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

export function flameGeometry(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(0.14, 0.26);
  a.translate(0, 0.12, 0);
  const b = a.clone().rotateY(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  const pa = a.toNonIndexed(), pb = b.toNonIndexed();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...pa.getAttribute('position').array, ...pb.getAttribute('position').array], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([...pa.getAttribute('uv').array, ...pb.getAttribute('uv').array], 2));
  return g;
}

