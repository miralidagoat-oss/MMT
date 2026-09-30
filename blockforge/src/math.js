// Small allocation-free matrix helpers (column-major, WebGL convention).

export function mat4() { return new Float32Array(16); }

export function identity(o) {
  o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
}

export function perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  o.fill(0);
  o[0] = f / aspect; o[5] = f;
  o[10] = (far + near) * nf; o[11] = -1;
  o[14] = 2 * far * near * nf;
  return o;
}

export function multiply(o, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return o;
}

export function invert(o, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity(o);
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

// Rotation-only view matrix for a camera with yaw (around +Y, 0 = looking -Z,
// positive turns toward +X) and pitch (positive looks up). Optional roll.
export function viewRotation(o, yaw, pitch, roll = 0) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // forward f, right r, back b = -f, up u = b x r
  const fx = sy * cp, fy = sp, fz = -cy * cp;
  let rx = cy, ry = 0, rz = sy;
  const bx = -fx, by = -fy, bz = -fz;
  let ux = by * rz - bz * ry, uy = bz * rx - bx * rz, uz = bx * ry - by * rx;
  if (roll) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const nrx = rx * cr + ux * sr, nry = ry * cr + uy * sr, nrz = rz * cr + uz * sr;
    const nux = ux * cr - rx * sr, nuy = uy * cr - ry * sr, nuz = uz * cr - rz * sr;
    rx = nrx; ry = nry; rz = nrz; ux = nux; uy = nuy; uz = nuz;
  }
  o[0] = rx; o[4] = ry; o[8] = rz; o[12] = 0;
  o[1] = ux; o[5] = uy; o[9] = uz; o[13] = 0;
  o[2] = bx; o[6] = by; o[10] = bz; o[14] = 0;
  o[3] = 0; o[7] = 0; o[11] = 0; o[15] = 1;
  return o;
}

export function translate(o, a, x, y, z) {
  if (o !== a) o.set(a);
  o[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
  o[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
  o[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
  o[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
  return o;
}

export function scale(o, a, x, y, z) {
  if (o !== a) o.set(a);
  for (let i = 0; i < 4; i++) { o[i] *= x; o[4 + i] *= y; o[8 + i] *= z; }
  return o;
}

export function rotateX(o, a, r) {
  const s = Math.sin(r), c = Math.cos(r);
  if (o !== a) o.set(a);
  for (let i = 0; i < 4; i++) {
    const y = a[4 + i], z = a[8 + i];
    o[4 + i] = y * c + z * s; o[8 + i] = z * c - y * s;
  }
  return o;
}

export function rotateY(o, a, r) {
  const s = Math.sin(r), c = Math.cos(r);
  if (o !== a) o.set(a);
  for (let i = 0; i < 4; i++) {
    const x = a[i], z = a[8 + i];
    o[i] = x * c - z * s; o[8 + i] = x * s + z * c;
  }
  return o;
}

export function rotateZ(o, a, r) {
  const s = Math.sin(r), c = Math.cos(r);
  if (o !== a) o.set(a);
  for (let i = 0; i < 4; i++) {
    const x = a[i], y = a[4 + i];
    o[i] = x * c + y * s; o[4 + i] = y * c - x * s;
  }
  return o;
}

// Frustum planes (normalised) from a combined view-projection matrix.
export function frustumPlanes(out, m) {
  const p = (i, a, b, c, d) => {
    const l = Math.hypot(a, b, c);
    out[i] = a / l; out[i + 1] = b / l; out[i + 2] = c / l; out[i + 3] = d / l;
  };
  p(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
  p(4, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
  p(8, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
  p(12, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
  p(16, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);
  p(20, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
  return out;
}

// AABB (camera-relative) vs frustum test.
export function boxInFrustum(pl, x0, y0, z0, x1, y1, z1) {
  for (let i = 0; i < 24; i += 4) {
    const a = pl[i], b = pl[i + 1], c = pl[i + 2], d = pl[i + 3];
    const x = a > 0 ? x1 : x0, y = b > 0 ? y1 : y0, z = c > 0 ? z1 : z0;
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mod = (a, n) => ((a % n) + n) % n;
