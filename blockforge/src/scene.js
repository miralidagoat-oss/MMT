// Draws entities, the third-person player and the first-person hand.
import { mat4, identity, translate, scale, rotateX, rotateY, rotateZ } from './math.js';
import { MODELS, buildModelMeshes, ItemMeshes, OUTFITS, WYRM_PARTS } from './models.js';
import { cubeMesh } from './renderer.js';
import { faceTexture, B, TEX, SOLID } from './blocks.js';
import { DIRS } from './shapes.js';
import { ITEMS, I, ARMOR_PIECES } from './items.js';
import { FallingBlock, PrimedCrate, Mob, Projectile, Lightning } from './entities.js';
import { LASER_COLOR } from './laser.js';

const M = mat4(), P = mat4(), T = mat4();
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class SceneRenderer {
  constructor(renderer, blockTextures, itemTextures) {
    this.r = renderer;
    this.models = buildModelMeshes(renderer);
    this.items = new ItemMeshes(renderer, blockTextures, itemTextures);
    this.blockCubes = new Map();
    // arrow: shaft, head and two fletching fins (block texture layers)
    const parts = [
      cubeMesh(-0.02, -0.02, -0.3, 0.02, 0.02, 0.22, () => TEX.oak_planks),
      cubeMesh(-0.04, -0.04, -0.36, 0.04, 0.04, -0.28, () => TEX.stone),
      cubeMesh(-0.002, -0.07, 0.12, 0.002, 0.07, 0.28, () => TEX.white),
      cubeMesh(-0.07, -0.002, 0.12, 0.07, 0.002, 0.28, () => TEX.white),
    ];
    const all = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of parts) { all.set(a, o); o += a.length; }
    this.arrowModel = renderer.createModel(all);
    this.unitCube = renderer.createModel(cubeMesh(-0.5, 0, -0.5, 0.5, 1, 0.5, () => TEX.white));
    const join = (list) => {
      const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
      let k = 0;
      for (const a of list) { out.set(a, k); k += a.length; }
      return out;
    };
    const iron = () => TEX.iron_block, dark = () => TEX.coal_block, plank = () => TEX.oak_planks;
    // minecart: long along Z, open top
    const wheels = [];
    for (const wx of [-0.5, 0.42]) for (const wz of [-0.42, 0.28]) wheels.push(cubeMesh(wx, 0, wz, wx + 0.08, 0.16, wz + 0.14, dark));
    this.cartModel = renderer.createModel(join([
      cubeMesh(-0.42, 0.08, -0.55, 0.42, 0.16, 0.55, iron),
      cubeMesh(-0.48, 0.08, -0.6, 0.48, 0.64, -0.52, iron), cubeMesh(-0.48, 0.08, 0.52, 0.48, 0.64, 0.6, iron),
      cubeMesh(-0.48, 0.08, -0.52, -0.42, 0.64, 0.52, iron), cubeMesh(0.42, 0.08, -0.52, 0.48, 0.64, 0.52, iron),
      ...wheels,
    ]));
    this.boatModel = renderer.createModel(join([
      cubeMesh(-0.42, 0, -0.78, 0.42, 0.1, 0.78, plank),
      cubeMesh(-0.5, 0, -0.8, -0.42, 0.42, 0.8, plank), cubeMesh(0.42, 0, -0.8, 0.5, 0.42, 0.8, plank),
      cubeMesh(-0.42, 0, -0.8, 0.42, 0.42, -0.72, plank), cubeMesh(-0.42, 0, 0.72, 0.42, 0.42, 0.8, plank),
      cubeMesh(-0.42, 0.24, -0.08, 0.42, 0.31, 0.08, plank),
    ]));
    this.paddleModel = renderer.createModel(join([
      cubeMesh(0, -0.03, -0.03, 0.9, 0.03, 0.03, () => TEX.oak_log),
      cubeMesh(0.62, -0.035, -0.12, 0.95, 0.0, 0.12, plank),
    ]));
    this.pylonCore = renderer.createModel(cubeMesh(-0.3, -0.3, -0.3, 0.3, 0.3, 0.3, () => TEX.star_frame_eye));
    this.pylonCage = renderer.createModel(cubeMesh(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, () => TEX.glass));
    this.bobberModel = renderer.createModel(join([
      cubeMesh(-0.07, -0.07, -0.07, 0.07, 0.0, 0.07, () => TEX.white_wool),
      cubeMesh(-0.07, 0, -0.07, 0.07, 0.07, 0.07, () => TEX.red_wool),
    ]));
    this.orbModel = renderer.createModel(cubeMesh(-0.25, -0.25, -0.25, 0.25, 0.25, 0.25, () => TEX.star_frame_eye));
    this.signBoard = renderer.createModel(cubeMesh(-0.5, -0.25, -0.04, 0.5, 0.25, 0.04, plank));
    this.signPost = renderer.createModel(cubeMesh(-0.04, 0, -0.04, 0.04, 0.55, 0.04, () => TEX.oak_log));
    // a unit quad facing +Z for text (uv covers the whole canvas texture)
    this.textQuad = renderer.createModel(new Float32Array([
      0.5, -0.5, 0, 0, 0, 1, 1, 1, 0, 0.5, 0.5, 0, 0, 0, 1, 1, 0, 0,
      -0.5, 0.5, 0, 0, 0, 1, 0, 0, 0, -0.5, -0.5, 0, 0, 0, 1, 0, 1, 0,
    ]));
    this.signTex = new Map(); // key -> { text, tex }
    // The Photon Blaster, modelled in 1/16 block units pointing toward -Z: a lit
    // body and an unlit glowing part drawn with bloom.
    const u = 1 / 16;
    const bx = (x0, y0, z0, x1, y1, z1, layer) => cubeMesh(x0 * u, y0 * u, z0 * u, x1 * u, y1 * u, z1 * u, () => layer);
    const body = TEX.blaster_body, metal = TEX.blaster_metal, white = TEX.white;
    this.blasterSolid = renderer.createModel(join([
      bx(-1.5, 0, -6, 1.5, 3, 4, body),          // main body
      bx(-1, 3, -4, 1, 3.8, 2, metal),           // top rail
      bx(-0.7, 3.8, -2, 0.7, 5, 1, body),        // sight
      bx(-1, 0.5, -11, 1, 2.5, -6, metal),       // barrel
      bx(-1.2, 0.5, 4, 1.2, 2.6, 5.2, metal),    // back cap
      bx(-1, -5, 1.4, 1, 0, 3.6, body),          // grip
      bx(-0.4, -2.2, -1, 0.4, -1.6, 1.6, metal), // trigger guard
      bx(-0.3, -1.6, -0.2, 0.3, 0, 0.3, metal),  // trigger
    ]));
    this.blasterGlow = renderer.createModel(join([
      bx(-1.6, 0.2, -9.2, 1.6, 2.8, -8.4, white),   // emitter rings
      bx(-1.6, 0.2, -11.6, 1.6, 2.8, -10.8, white),
      bx(-0.7, 0.8, -11.9, 0.7, 2.2, -11.6, white), // muzzle
      bx(1.5, 1.1, -4.5, 1.7, 1.9, 1.5, white),      // side strips
      bx(-1.7, 1.1, -4.5, -1.5, 1.9, 1.5, white),
      bx(-1.1, -1.6, -3.4, 1.1, 0, 0.6, white),      // energy canister
      bx(-0.4, 4.2, -2.1, 0.4, 4.7, -2, white),      // sight lens
    ]));
    this.unitBox = renderer.createModel(cubeMesh(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, () => TEX.white));
    // soft round shadow under creatures and players
    const sc = document.createElement('canvas');
    sc.width = sc.height = 32;
    const g = sc.getContext('2d');
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(0,0,0,0.6)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.38)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
    this.blobTex = renderer.createCanvasTexture(sc);
    this.blobQuad = renderer.createModel(new Float32Array([
      -0.5, 0, -0.5, 0, 1, 0, 0, 0, 0, -0.5, 0, 0.5, 0, 1, 0, 0, 1, 0,
      0.5, 0, 0.5, 0, 1, 0, 1, 1, 0, 0.5, 0, -0.5, 0, 1, 0, 1, 0, 0,
    ]));
  }

  // The textures were repainted at another detail level.
  setTextures(blockTextures, itemTextures) {
    this.items.setTextures(blockTextures, itemTextures);
  }

  // The blaster model with base matrix m (model units are blocks).
  drawBlaster(m, light, env, opts = {}, charge = 1) {
    this.r.drawModel(this.blasterSolid, m, 'block', light, env, { ...opts, blockMode: 1 });
    const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 160);
    const g = 0.35 + 0.65 * charge;
    this.r.drawModel(this.blasterGlow, m, 'block', [1, 1], env, { ...opts, mode: 1, glow: 1, tintColor: [LASER_COLOR[0] * g * pulse, LASER_COLOR[1] * g * pulse, LASER_COLOR[2] * g * pulse] });
  }

  // A round shadow on the ground under (x, y, z), fading with height.
  blob(x, y, z, radius, cam, env, world) {
    const bx = Math.floor(x), bz = Math.floor(z);
    let gy = null;
    for (let yy = Math.floor(y + 0.05); yy >= Math.floor(y) - 3; yy--) {
      if (SOLID[world.getBlock(bx, yy - 1, bz)]) { gy = yy; break; }
    }
    if (gy === null) return;
    const h = y - gy;
    if (h > 3 || h < -0.6) return;
    identity(M);
    translate(M, M, x - cam.x, gy - cam.y + 0.025, z - cam.z);
    const s = radius * 2 * (1 - h * 0.12);
    scale(M, M, s, 1, s);
    this.r.drawModel(this.blobQuad, M, this.blobTex, [1, 1], env, { mode: 1, blend: true, alpha: Math.max(0, 1 - h / 3), noCull: true });
  }

  drawBlobs(game, cam, env, alpha) {
    const world = game.world;
    const near = (x, z, r) => (x - cam.x) * (x - cam.x) + (z - cam.z) * (z - cam.z) < r * r;
    for (const e of game.entities) {
      if (!(e instanceof Mob) && !e.isCart && !e.isBoat) continue;
      if (e.effects && e.effects.invisibility) continue;
      const [x, y, z] = e.lerpPos(alpha);
      if (!near(x, z, 40)) continue;
      if (e.isBoat) continue; // boats sit in water
      this.blob(x, y, z, Math.max(0.3, e.w * 1.1), cam, env, world);
    }
    for (const it of game.items) {
      const [x, y, z] = it.lerpPos(alpha);
      if (near(x, z, 20)) this.blob(x, y, z, 0.22, cam, env, world);
    }
    if (game.remotePlayers) for (const rp of game.remotePlayers()) {
      const [x, y, z] = rp.lerpPos(alpha);
      if (near(x, z, 40) && !(rp.effects && rp.effects.invisibility)) this.blob(x, y, z, 0.36, cam, env, world);
    }
    const p = game.player;
    if (game.perspective !== 0 && !p.dead && !(p.effects && p.effects.invisibility)) {
      const [x, y, z] = p.lerpPos(alpha);
      this.blob(x, y, z, 0.36, cam, env, world);
    }
  }

  // Text for a sign, painted to a small canvas texture (cached by content).
  signTexture(key, lines) {
    const text = lines.join('\n');
    let e = this.signTex.get(key);
    if (e && e.text === text) return e.tex;
    const c = this.textCanvas || (this.textCanvas = document.createElement('canvas'));
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = '#2a1a0c';
    g.font = 'bold 24px "Pixelify Sans", "Trebuchet MS", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l.slice(0, 15), 128, 18 + i * 31));
    const tex = this.r.createCanvasTexture(c, e ? e.tex : null);
    this.signTex.set(key, { text, tex });
    return tex;
  }

  // A thin box from a to b (lines, beams).
  segment(a, b, cam, thick, light, env, opts) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    identity(M);
    translate(M, M, a[0] - cam.x, a[1] - cam.y, a[2] - cam.z);
    rotateY(M, M, Math.atan2(dx, dz));
    rotateX(M, M, Math.atan2(Math.hypot(dx, dz), dy));
    scale(M, M, thick, len, thick);
    this.r.drawModel(this.unitCube, M, 'block', light, env, opts);
  }

  blockCube(id, meta = 0) {
    const k = id * 256 + meta;
    let m = this.blockCubes.get(k);
    if (!m) {
      m = this.r.createModel(cubeMesh(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5, (f) => faceTexture(id, f, meta)));
      this.blockCubes.set(k, m);
    }
    return m;
  }

  lightAt(world, x, y, z) {
    const l = world.getLight(Math.floor(x), Math.floor(y), Math.floor(z));
    return [(l >> 4) / 15, (l & 15) / 15];
  }

  // Draw all entities (called inside the renderer's opaque pass).
  drawEntities(game, cam, env, alpha) {
    const r = this.r, world = game.world;
    if (game.settings.entityShadows) this.drawBlobs(game, cam, env, alpha);
    for (const e of game.entities) {
      const [x, y, z] = e.lerpPos(alpha);
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
      if (dx * dx + dz * dz > 96 * 96 && !(e instanceof Lightning) && !e.isWyrm) continue;
      if (e instanceof Mob) this.drawMob(e, x, y, z, cam, env, alpha, world);
      else if (e.isCart) this.drawCart(e, x, y, z, cam, env, alpha, world);
      else if (e.isBoat) this.drawBoat(e, x, y, z, cam, env, alpha, world);
      else if (e.isPylon) this.drawPylon(e, x, y, z, cam, env, alpha, game);
      else if (e.isWyrm) this.drawWyrm(e, cam, env, alpha, world);
      else if (e.isOrb) { identity(M); translate(M, M, dx, dy, dz); rotateY(M, M, (e.age + alpha) * 0.3); rotateX(M, M, (e.age + alpha) * 0.2); this.r.drawModel(this.orbModel, M, 'block', [1, 1], env, { mode: 1, glow: 1 }); }
      else if (e.isBobber) this.drawBobber(e, x, y, z, cam, env, alpha, game);
      else if (e.isStarEye) this.drawFloatingItem(I.star_eye, x, y, z, cam, env, alpha, e.age, [1, 1]);
      else if (e.isRocket) {
        const mesh = this.items.get(I.sky_rocket);
        identity(M); translate(M, M, dx, dy + 0.2, dz); rotateY(M, M, -cam.yaw); scale(M, M, 0.45, 0.45, 0.45);
        if (mesh) this.r.drawModel(mesh.model, M, mesh.tex, [1, 1], env, { blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: true });
      }
      else if (e instanceof Projectile) this.drawProjectile(e, x, y, z, cam, env, world);
      else if (e instanceof Lightning) this.drawLightning(e, cam, env);
      else if (e instanceof FallingBlock || e instanceof PrimedCrate) {
        const id = e instanceof FallingBlock ? e.block : B.tnt;
        identity(M);
        translate(M, M, dx, dy + 0.5, dz);
        let tint;
        if (e instanceof PrimedCrate) {
          const s = 1 + Math.max(0, (10 - e.fuse + alpha) / 10) * 0.2;
          scale(M, M, s, s, s);
          tint = (Math.floor(e.fuse / 5) % 2) ? [1, 1, 1, 0.55] : undefined;
        }
        const it = this.items.get(id);
        r.drawModel(this.blockCube(id), M, 'block', this.lightAt(world, x, y + 0.5, z), env, { tint, blockMode: 1, tintColor: it ? it.tint : undefined });
      }
    }
    this.drawSigns(game, cam, env);
    if (game.remotePlayers) for (const rp of game.remotePlayers()) this.drawRemote(rp, game, cam, env, alpha);
    for (const it of game.items) {
      const [x, y, z] = it.lerpPos(alpha);
      const dx = x - cam.x, dz = z - cam.z;
      if (dx * dx + dz * dz > 48 * 48) continue;
      this.drawItemEntity(it, x, y, z, cam, env, alpha, world);
    }
    if (game.perspective !== 0 && !game.player.dead) this.drawPlayer(game, cam, env, alpha);
  }

  drawProjectile(e, x, y, z, cam, env, world) {
    identity(M);
    translate(M, M, x - cam.x, y - cam.y, z - cam.z);
    const light = this.lightAt(world, x, y, z);
    if (e.kind === 'arrow') {
      rotateY(M, M, -e.yaw);
      rotateX(M, M, e.pitch);
      this.r.drawModel(this.arrowModel, M, 'block', light, env, { blockMode: 0 });
      return;
    }
    if (e.kind === 'laser') {
      // a glowing core inside a softer halo, trailing behind the bolt's head
      rotateY(M, M, -e.yaw);
      rotateX(M, M, e.pitch);
      const len = Math.min(1.6, 0.4 + e.age * 0.6);
      translate(M, M, 0, 0, len * 0.5);
      T.set(M);
      scale(T, T, 0.18, 0.18, len + 0.1);
      this.r.drawModel(this.unitBox, T, 'block', [1, 1], env, { mode: 1, glow: 1, blend: true, alpha: 0.28, tintColor: LASER_COLOR, noCull: true });
      scale(M, M, 0.06, 0.06, len);
      this.r.drawModel(this.unitBox, M, 'block', [1, 1], env, { mode: 1, glow: 1, tintColor: [0.85, 1, 1] });
      return;
    }
    const mesh = this.items.get(e.kind === 'egg' ? I.egg : e.kind === 'snowball' ? I.snowball : e.kind === 'pearl' ? I.void_pearl : e.item);
    if (!mesh) return;
    rotateY(M, M, -cam.yaw);
    scale(M, M, 0.3, 0.3, 0.3);
    this.r.drawModel(mesh.model, M, mesh.tex, light, env, { blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: true });
  }

  drawLightning(e, cam, env) {
    let seed = e.seed;
    const rnd = () => { seed = (seed * 1103515245 + 12345) | 0; return ((seed >>> 8) & 0xffff) / 65536; };
    let px = e.x, pz = e.z;
    const top = e.y + 90;
    for (let yy = top; yy > e.y; yy -= 6) {
      const nx = px + (rnd() - 0.5) * 3, nz = pz + (rnd() - 0.5) * 3;
      const y0 = Math.max(e.y, yy - 6);
      identity(M);
      translate(M, M, (px + nx) / 2 - cam.x, y0 - cam.y, (pz + nz) / 2 - cam.z);
      scale(M, M, 0.22 + Math.abs(nx - px) * 0.6, yy - y0, 0.22 + Math.abs(nz - pz) * 0.6);
      this.r.drawModel(this.unitCube, M, 'block', [1, 1], env, { mode: 1, glow: 1 });
      px = nx; pz = nz;
    }
  }

  drawItemEntity(it, x, y, z, cam, env, alpha, world) {
    if (it.stack.id === I.photon_blaster) {
      const age = it.age + alpha;
      identity(M);
      translate(M, M, x - cam.x, y - cam.y + Math.sin(age / 10 + it.spin) * 0.1 + 0.25, z - cam.z);
      rotateY(M, M, age * 0.05 + it.spin);
      scale(M, M, 0.75, 0.75, 0.75);
      this.drawBlaster(M, this.lightAt(world, x, y + 0.2, z), env, {}, 1);
      return;
    }
    const mesh = this.items.get(it.stack.id);
    if (!mesh) return;
    const age = it.age + alpha;
    const bob = Math.sin(age / 10 + it.spin) * 0.1 + 0.1;
    const light = this.lightAt(world, x, y + 0.2, z);
    const copies = it.stack.count > 32 ? 4 : it.stack.count > 16 ? 3 : it.stack.count > 1 ? 2 : 1;
    const isBlock = mesh.kind === 'block';
    for (let i = 0; i < copies; i++) {
      identity(M);
      const o = i * 0.07;
      translate(M, M, x - cam.x + (i ? Math.sin(i * 7.1) * o : 0), y - cam.y + bob + (isBlock ? 0.125 : 0.2) + (i ? o * 0.5 : 0), z - cam.z + (i ? Math.cos(i * 3.3) * o : 0));
      rotateY(M, M, age * 0.05 + it.spin);
      const s = isBlock ? 0.25 : 0.42;
      scale(M, M, s, s, s);
      if (!isBlock) translate(M, M, 0, 0, i * 0.06);
      this.r.drawModel(mesh.model, M, mesh.tex, light, env, { blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: !isBlock });
    }
  }

  // Pose each part and draw it.
  // Transform for one posed part into P.
  partMatrix(out, base, def, partName, poses) {
    const p = def.parts[partName];
    const pose = poses[p.parent || partName];
    out.set(base);
    if (pose) {
      const [px, py, pz] = p.pivot;
      translate(out, out, px, py, pz);
      if (pose[1]) rotateY(out, out, pose[1]);
      if (pose[0]) rotateX(out, out, pose[0]);
      if (pose[2]) rotateZ(out, out, pose[2]);
      translate(out, out, -px, -py, -pz);
    }
    return out;
  }

  drawParts(name, poses, base, light, env, opts, hidden, meshSet) {
    const def = MODELS[name];
    const meshes = meshSet || this.models[name];
    for (const pn of Object.keys(def.parts)) {
      if (hidden && hidden.has(pn)) continue;
      this.partMatrix(P, base, def, pn, poses);
      this.r.drawModel(meshes[pn], P, 'skin', light, env, opts);
    }
  }

  // Worn armor over a humanoid model. ids: [helmet, chest, legs, boots]
  drawArmor(name, ids, poses, base, light, env, opts) {
    const def = MODELS[name];
    for (let i = 0; i < 4; i++) {
      const id = ids[i];
      const a = id && ITEMS[id] && ITEMS[id].armor;
      if (!a || !this.models.armor[a.mat]) continue;
      for (const part of this.models.armor[a.mat][ARMOR_PIECES[i]]) {
        if (!def.parts[part.follow]) continue;
        this.partMatrix(P, base, def, part.follow, poses);
        this.r.drawModel(part.model, P, 'skin', light, env, opts);
      }
    }
  }

  // Held item at the end of a humanoid's arm.
  drawHeld(name, id, poses, base, light, env, arm = 'armR', bow = false) {
    const mesh = this.items.get(id);
    if (!mesh) return;
    const def = MODELS[name];
    this.partMatrix(P, base, def, arm, poses);
    const pv = def.parts[arm].pivot;
    const bx = def.parts[arm].box;
    translate(P, P, pv[0], bx[1] + 1, 0);
    if (bow) { rotateY(P, P, Math.PI / 2); rotateZ(P, P, -0.7); scale(P, P, 12, 12, 12); }
    else if (mesh.kind === 'block') { scale(P, P, 6, 6, 6); rotateY(P, P, 0.785); }
    else { rotateX(P, P, -1.3); scale(P, P, 10, 10, 10); translate(P, P, 0, 0.25, 0); }
    this.r.drawModel(mesh.model, P, mesh.tex, light, env, { blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: mesh.kind !== 'block' });
  }

  drawMob(e, x, y, z, cam, env, alpha, world) {
    const def = MODELS[e.def.model];
    const bodyYaw = lerpAngle(e.pyaw, e.yaw, alpha);
    identity(T);
    translate(T, T, x - cam.x, y - cam.y, z - cam.z);
    rotateY(T, T, -bodyYaw);
    if (e.dead) {
      const t = Math.min(1, Math.sqrt(((e.deathTime + alpha) / 20) * 1.6));
      rotateZ(T, T, t * Math.PI / 2);
    }
    const sc = e.baby ? 0.5 : 1;
    scale(T, T, sc / 16, sc / 16, sc / 16);
    const la = lerp(e.pLimbAmount, e.limbAmount, alpha);
    const ls = e.limbSwing + alpha * (e.limbAmount * 0.3);
    const sw = Math.cos(ls * 0.6662) * 1.2 * la;
    const poses = {};
    const headYaw = e.headYaw || 0, headPitch = e.headPitch || 0;
    poses.head = [headPitch, headYaw, 0];
    if (e.type === 'crawler') {
      for (let i = 0; i < 8; i++) {
        const side = i % 2 ? -1 : 1, pair = i >> 1;
        const spread = [-0.55, -0.2, 0.2, 0.55][pair];
        const walk = Math.sin(ls * 0.9 + (pair % 2) * Math.PI + (side > 0 ? 0 : Math.PI)) * 0.35 * la;
        poses['leg' + i] = [0, (spread + walk) * side, (0.45 + Math.abs(Math.cos(ls * 0.9 + pair)) * 0.2 * la) * side];
      }
    } else if (def.parts.leg0) {
      poses.leg0 = [sw, 0, 0]; poses.leg3 = [sw, 0, 0];
      poses.leg1 = [-sw, 0, 0]; poses.leg2 = [-sw, 0, 0];
    }
    if (e.type === 'chicken') {
      poses.legR = [sw, 0, 0]; poses.legL = [-sw, 0, 0];
      const flap = Math.sin(e.wingFlap + alpha * 0.6) * (e.onGround ? 0.05 : 0.9);
      poses.wingR = [0, 0, -Math.abs(flap)]; poses.wingL = [0, 0, Math.abs(flap)];
    }
    if (e.type === 'pig') poses.tail = [0, Math.sin((e.age + alpha) * 0.3) * 0.4, 0];
    if (def.humanoid && e.type !== 'crawler') {
      poses.legR = [sw, 0, 0]; poses.legL = [-sw, 0, 0];
      poses.armR = [-sw * 0.7, 0, 0.05]; poses.armL = [sw * 0.7, 0, -0.05];
    }
    if (e.type === 'ghoul') {
      let arm = 0.25 + (e.target ? 1.15 : 0);
      if (e.swing > 0) arm += Math.sin(((10 - e.swing + alpha) / 10) * Math.PI) * 0.8;
      poses.armR = [arm - sw * 0.5, 0, 0.05]; poses.armL = [arm + sw * 0.5, 0, -0.05];
    }
    if (e.type === 'archer' && e.target) {
      poses.armR = [Math.PI / 2 - headPitch, -0.1, 0]; poses.armL = [Math.PI / 2 - headPitch, 0.5, 0];
    }
    if (e.type === 'imp') {
      poses.tail = [0.3, Math.sin((e.age + alpha) * 0.25) * 0.5, 0];
      if (e.swing > 0) poses.armR = [1.5 * Math.sin(((10 - e.swing + alpha) / 10) * Math.PI), 0, 0.05];
    }
    if (e.type === 'settler' && e.swing > 0) poses.armR = [1.2, 0, 0];
    const t = e.age + alpha;
    if (e.type === 'hound') {
      const wag = e.tamed ? Math.sin(t * 0.5) * 0.6 : e.angry > 0 ? 0 : Math.sin(t * 0.25) * 0.2;
      poses.tail = [e.tamed ? -1.1 : e.angry > 0 ? -1.4 : -0.6, wag, 0];
      if (e.sitting) {
        translate(T, T, 0, -2.5, 0);
        poses.body = [-0.45, 0, 0]; poses.mane = [-0.2, 0, 0]; poses.collar = [-0.2, 0, 0];
        poses.leg2 = [1.35, 0, 0]; poses.leg3 = [1.35, 0, 0]; poses.leg0 = [-0.15, 0, 0]; poses.leg1 = [-0.15, 0, 0];
        poses.tail = [-0.2, wag * 0.3, 0];
      }
    }
    if (e.type === 'steed') {
      poses.neck = [-0.25 + (e.headPitch || 0) * 0.4, (e.headYaw || 0) * 0.5, 0];
      delete poses.head;
      poses.tail = [-0.45 - la * 0.4, Math.sin(t * 0.2) * 0.25, 0];
      if (e.bucking > 0) { translate(T, T, 0, 0, 8); rotateX(T, T, Math.min(0.5, e.bucking / 20) * Math.abs(Math.sin(t * 0.3))); translate(T, T, 0, 0, -8); }
    }
    if (e.type === 'sentinel') {
      poses.armR = [-sw * 0.4, 0, 0.03]; poses.armL = [sw * 0.4, 0, -0.03];
      if (e.swing > 0) { const k = Math.sin(((10 - e.swing + alpha) / 10) * Math.PI) * 1.8; poses.armR = [k, 0, 0.03]; poses.armL = [k, 0, -0.03]; }
    }
    if (e.type === 'frost_sentinel') { poses.armR = [0, 0, 0.3 + Math.sin(t * 0.1) * 0.05]; poses.armL = [0, 0, -0.3 - Math.sin(t * 0.1) * 0.05]; }
    if (e.type === 'hexer') {
      if (e.drinking > 0) poses.armR = [1.5, -0.3, 0];
      else if (e.swing > 0) poses.armR = [1.4 * Math.sin(((10 - e.swing + alpha) / 10) * Math.PI), 0, 0];
    }
    if (e.type === 'tide_warden') { poses.tail = [0, Math.sin(e.limbSwing * 0.6 + t * 0.15) * 0.5, 0]; }
    const light = e.type === 'imp' ? [0.4, 1] : this.lightAt(world, x, y + def.height * 0.6, z);
    const hurt = e.hurtTime > 0 || e.dead;
    const opts = { tint: hurt ? [0.9, 0.1, 0.1, 0.45] : e.fire > 0 ? [1, 0.5, 0.1, 0.15] : undefined };
    let hidden = e.type === 'sheep' && (e.sheared || e.baby) ? new Set(['wool', 'headWool']) : null;
    let meshes = null;
    if (e.type === 'hound' && !e.tamed) hidden = new Set(['collar']);
    if (e.type === 'steed') {
      if (!e.saddled) hidden = new Set(['saddle', 'strapR', 'strapL', 'bridle']);
      if (e.variant && this.models['steed:' + e.variant]) meshes = this.models['steed:' + e.variant];
    }
    if (e.type === 'settler') {
      const prof = e.profession || 'farmer';
      meshes = this.models[`settler:${prof}`] || this.models.settler;
      if (!OUTFITS[prof] || !OUTFITS[prof].hat) hidden = new Set(['brim', 'crown']);
    }
    this.drawParts(e.def.model, poses, T, light, env, opts, hidden, meshes);
    if (e.armor) this.drawArmor(e.def.model, e.armor, poses, T, light, env, opts);
    if (e.type === 'archer') this.drawHeld('archer', I.bow, poses, T, light, env, 'armL', true);
    if (e.type === 'hexer' && e.drinking > 0) this.drawHeld('hexer', e.drinkKind === 'fire_resistance' ? I.potion_fire_resistance : I.potion_healing, poses, T, light, env, 'armR');
    if (e.type === 'tide_warden' && e.beamTarget && e.beam > 0) {
      // the warden's beam brightens from amber to white as it charges
      const tg = e.beamTarget;
      const [bx, by, bz] = tg.lerpPos ? tg.lerpPos(alpha) : [tg.x, tg.y, tg.z];
      const f = Math.min(1, e.beam / 60);
      this.segment([x, y + 0.45, z], [bx, by + 1.1, bz], cam, 0.06 + f * 0.06, [1, 1], env, { mode: 1, glow: 1, tintColor: [1, 0.55 + f * 0.45, 0.3 + f * 0.7] });
    }
    if (e.customName) this.nameTag(e.customName, x, y + def.height * (e.baby ? 0.5 : 1) + (e.type === 'hexer' ? 0.75 : 0.35), z, cam, env);
  }

  // A floating name label above a creature or player.
  nameTag(name, x, y, z, cam, env) {
    const key = 'tag:' + name;
    let tag = this.signTex.get(key);
    if (!tag) {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 48;
      const g = c.getContext('2d');
      g.font = 'bold 26px "Pixelify Sans", "Trebuchet MS", sans-serif';
      const wdt = Math.min(250, g.measureText(name).width + 16);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(128 - wdt / 2, 4, wdt, 40);
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name, 128, 25);
      tag = { text: name, tex: this.r.createCanvasTexture(c) };
      this.signTex.set(key, tag);
    }
    identity(M);
    translate(M, M, x - cam.x, y - cam.y, z - cam.z);
    rotateY(M, M, -cam.yaw);
    scale(M, M, 1.6, 0.3, 1);
    this.r.drawModel(this.textQuad, M, tag.tex, [1, 1], env, { blockMode: 0, mode: 1, blend: true, noCull: true });
  }

  playerPoses(p, alpha, swing) {
    const la = Math.min(1, lerp(p.pbob, p.bob, alpha) * 12);
    const ls = lerp(p.pWalkDist, p.walkDist, alpha) * 3.2;
    const sw = Math.cos(ls * 0.6662) * 1.1 * la;
    const bodyYaw = p.bodyYaw ?? p.yaw;
    const headYaw = -(lerpAngle(p.pyaw, p.yaw, alpha) - bodyYaw);
    const poses = {
      head: [-lerp(p.ppitch, p.pitch, alpha), headYaw, 0],
      legR: [sw, 0, 0], legL: [-sw, 0, 0],
      armR: [-sw * 0.8, 0, 0.04], armL: [sw * 0.8, 0, -0.04],
    };
    if (p.sneaking) { poses.body = [0.4, 0, 0]; }
    if (swing > 0) {
      const s = Math.sin(Math.sqrt(swing) * Math.PI);
      poses.armR = [1.3 * s, -0.3 * s, 0.04];
    }
    return poses;
  }

  drawPlayer(game, cam, env, alpha) {
    const p = game.player;
    this.drawHumanoid(p, p.lerpPos(alpha), game, cam, env, alpha, game.swingProgress(alpha), p.inventory.held, [36, 37, 38, 39].map((i) => p.inventory.get(i)));
  }

  // The player model for the local player and for other players.
  drawHumanoid(p, pos, game, cam, env, alpha, swing, held, worn, skinMeshes) {
    const [x, y, z] = pos;
    // body turns toward the look direction when walking
    if (p.bodyYaw === undefined) p.bodyYaw = p.yaw;
    const d = p.yaw - p.bodyYaw;
    const dd = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(dd) > 0.8 || p.bob > 0.01) p.bodyYaw += dd * 0.2;
    identity(T);
    translate(T, T, x - cam.x, y - cam.y - (p.sneaking ? 0.12 : 0), z - cam.z);
    rotateY(T, T, -p.bodyYaw);
    if (p.gliding) { translate(T, T, 0, 0.9, 0); rotateX(T, T, -Math.PI / 2 * 0.85 - (p.pitch || 0) * 0.5); translate(T, T, 0, -0.9, 0); }
    scale(T, T, 0.9375 / 16, 0.9375 / 16, 0.9375 / 16);
    const light = this.lightAt(game.world, x, y + 1, z);
    const poses = this.playerPoses(p, alpha, swing);
    if (p.vehicle || p.riding) {
      poses.legR = [-1.4, 0.15, 0]; poses.legL = [-1.4, -0.15, 0];
      poses.armR = [-0.5, 0, 0.1]; poses.armL = [-0.5, 0, -0.1];
    }
    if (p.gliding) { poses.legR = [0, 0, 0.1]; poses.legL = [0, 0, -0.1]; poses.armR = [0, 0, 0.5]; poses.armL = [0, 0, -0.5]; }
    if (p.blocking) poses.armR = [0.9, -0.5, 0];
    const aiming = held && held.id === I.photon_blaster && !p.gliding && !p.sleeping;
    if (aiming) {
      // both hands on the blaster, aimed where the player looks
      const pt = lerp(p.ppitch ?? p.pitch, p.pitch, alpha);
      poses.armR = [Math.PI / 2 + pt, -0.06, 0];
      poses.armL = [Math.PI / 2 + pt - 0.1, 0.62, 0];
    }
    const popts = { tint: p.hurtTime > 0 ? [0.9, 0.1, 0.1, 0.45] : undefined };
    const invisible = p.effects && p.effects.invisibility;
    if (!invisible) this.drawParts('player', poses, T, light, env, popts, null, skinMeshes);
    const wornIds = worn.map((st) => (st ? st.id : 0));
    if (wornIds.some(Boolean)) this.drawArmor('player', wornIds, poses, T, light, env, popts);
    if (wornIds[1] === I.glider) {
      const spread = p.gliding ? 1.25 : 0.2;
      for (const side of ['wingR', 'wingL']) {
        this.partMatrix(P, T, MODELS.player, 'body', poses);
        translate(P, P, 0, 24, 2);
        rotateZ(P, P, side === 'wingR' ? -spread : spread);
        rotateX(P, P, p.gliding ? 0.2 : 0.1);
        translate(P, P, 0, -24, -2);
        this.r.drawModel(this.models.glider[side], P, 'skin', light, env, { ...popts, noCull: true });
      }
    }
    // held item in the right hand
    if (aiming) {
      P.set(T);
      const pose = poses.armR;
      translate(P, P, -6, 22, 0);
      rotateX(P, P, pose[0]); rotateY(P, P, pose[1]); rotateZ(P, P, pose[2]);
      translate(P, P, 6, -22, 0);
      translate(P, P, -6, 11.5, -1);
      rotateX(P, P, Math.PI / 2);
      scale(P, P, 10, 10, 10);
      translate(P, P, 0, -0.06, 0.16);
      this.drawBlaster(P, light, env, popts, 1);
    } else if (held) {
      const mesh = this.items.get(held.id);
      if (mesh) {
        P.set(T);
        const pose = poses.armR;
        translate(P, P, -6, 22, 0);
        rotateX(P, P, pose[0]); rotateY(P, P, pose[1]); rotateZ(P, P, pose[2]);
        translate(P, P, 6, -22, 0);
        translate(P, P, -6, 12, -2);
        if (mesh.kind === 'block') { scale(P, P, 6, 6, 6); rotateY(P, P, 0.785); }
        else { rotateX(P, P, -1.3); scale(P, P, 10, 10, 10); translate(P, P, 0, 0.25, 0); }
        this.r.drawModel(mesh.model, P, mesh.tex, light, env, { blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: mesh.kind !== 'block' });
      }
    }
  }

  // ---------------------------------------------------------------------------
  drawFloatingItem(id, x, y, z, cam, env, alpha, age, light) {
    const mesh = this.items.get(id);
    if (!mesh) return;
    identity(M);
    translate(M, M, x - cam.x, y - cam.y, z - cam.z);
    rotateY(M, M, (age + alpha) * 0.1);
    scale(M, M, 0.4, 0.4, 0.4);
    this.r.drawModel(mesh.model, M, mesh.tex, light, env, { blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: true });
  }

  drawCart(e, x, y, z, cam, env, alpha, world) {
    identity(M);
    const sh = e.shake > 0 ? Math.sin((e.shake - alpha) * 2) * 0.05 * e.shake / 10 : 0;
    translate(M, M, x - cam.x, y - cam.y, z - cam.z);
    rotateY(M, M, -lerpAngle(e.pyaw, e.yaw, alpha));
    rotateX(M, M, -(e.pitch || 0) + sh);
    this.r.drawModel(this.cartModel, M, 'block', this.lightAt(world, x, y + 0.5, z), env, { blockMode: 1 });
  }

  drawBoat(e, x, y, z, cam, env, alpha, world) {
    const light = this.lightAt(world, x, y + 0.6, z);
    identity(T);
    translate(T, T, x - cam.x, y - cam.y, z - cam.z);
    rotateY(T, T, -lerpAngle(e.pyaw, e.yaw, alpha));
    if (e.shake > 0) rotateZ(T, T, Math.sin((e.shake - alpha) * 2) * 0.08 * e.shake / 10);
    this.r.drawModel(this.boatModel, T, 'block', light, env, { blockMode: 1 });
    const pa = lerp(e.ppaddle, e.paddle, alpha);
    for (const side of [1, -1]) {
      M.set(T);
      translate(M, M, 0.5 * side, 0.4, 0);
      rotateY(M, M, side > 0 ? 0 : Math.PI);
      rotateY(M, M, Math.sin(pa) * 0.6);
      rotateZ(M, M, -0.5 - Math.cos(pa) * 0.25);
      this.r.drawModel(this.paddleModel, M, 'block', light, env, { blockMode: 1 });
    }
  }

  drawPylon(e, x, y, z, cam, env, alpha, game) {
    const t = e.age + alpha + e.spin * 30;
    const bob = Math.sin(t * 0.06) * 0.25;
    identity(M);
    translate(M, M, x - cam.x, y - cam.y + 0.8 + bob, z - cam.z);
    rotateY(M, M, t * 0.05); rotateX(M, M, 0.6);
    this.r.drawModel(this.pylonCore, M, 'block', [1, 1], env, { mode: 1, glow: 1 });
    identity(M);
    translate(M, M, x - cam.x, y - cam.y + 0.8 + bob, z - cam.z);
    rotateY(M, M, -t * 0.03); rotateZ(M, M, 0.6);
    this.r.drawModel(this.pylonCage, M, 'block', [1, 1], env, { blockMode: 2 });
    // healing beam to the wyrm
    const w = game.wyrm;
    if (w && w.healing === e && !w.dying) {
      const [hx, hy, hz] = w.lerpPos(alpha);
      this.segment([x, y + 0.8 + bob, z], [hx, hy, hz], cam, 0.18, [1, 1], env, { mode: 1, glow: 1, tint: [0.8, 0.6, 1, 0.4] });
    }
  }

  drawWyrm(e, cam, env, alpha, world) {
    const hurt = e.hurtTime > 0 || e.dying;
    const opts = { tint: hurt ? [0.9, 0.2, 0.3, 0.4] : undefined };
    const light = [0.85, 0.6];
    const part = (name, px, py, pz, yaw, pitch, sc) => {
      identity(M);
      translate(M, M, px - cam.x, py - cam.y, pz - cam.z);
      rotateY(M, M, -yaw);
      rotateX(M, M, pitch);
      scale(M, M, sc / 4, sc / 4, sc / 4);
      this.r.drawModel(this.models.wyrm[name], M, 'skin', light, env, opts);
    };
    const [hx, hy, hz] = e.lerpPos(alpha);
    const yaw = lerpAngle(e.pyaw, e.yaw, alpha);
    part('head', hx, hy, hz, yaw, e.pitch, 1);
    part('hornR', hx, hy, hz, yaw, e.pitch, 1);
    part('hornL', hx, hy, hz, yaw, e.pitch, 1);
    const n = e.segs.length;
    e.segs.forEach((s, i) => {
      const sx = lerp(s.px, s.x, alpha), sy = lerp(s.py, s.y, alpha), sz = lerp(s.pz, s.z, alpha);
      const sc = 1 - (i / n) * 0.55;
      if (i < n - 3) { part('body', sx, sy, sz, s.yaw, s.pitch, sc); if (i % 2 === 0) part('spike', sx, sy, sz, s.yaw, s.pitch, sc); }
      else part('tail', sx, sy, sz, s.yaw, s.pitch, sc * 1.4);
    });
    void WYRM_PARTS; void world;
  }

  drawBobber(e, x, y, z, cam, env, alpha, game) {
    identity(M);
    translate(M, M, x - cam.x, y - cam.y, z - cam.z);
    const light = this.lightAt(game.world, x, y + 0.3, z);
    this.r.drawModel(this.bobberModel, M, 'block', light, env, { blockMode: 1 });
    // the line, sagging from the rod tip
    const o = e.owner;
    if (!o) return;
    let a;
    if (o === game.player && game.perspective === 0) {
      const [ex, ey, ez] = game.eyePos(alpha);
      const yaw = o.yaw, cp = Math.cos(o.pitch);
      const fx = Math.sin(yaw) * cp, fy = Math.sin(o.pitch), fz = -Math.cos(yaw) * cp;
      const rx = Math.cos(yaw), rz = Math.sin(yaw);
      a = [ex + fx * 0.8 + rx * 0.35, ey + fy * 0.8 - 0.25 + 0.3, ez + fz * 0.8 + rz * 0.35];
    } else {
      const [ox, oy, oz] = o.lerpPos ? o.lerpPos(alpha) : [o.x, o.y, o.z];
      const yaw = o.bodyYaw ?? o.yaw;
      a = [ox + Math.cos(yaw) * 0.4 + Math.sin(yaw) * 0.9, oy + 2.0, oz + Math.sin(yaw) * 0.4 - Math.cos(yaw) * 0.9];
    }
    const b = [x, y + 0.05, z];
    const N = 12, len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let prev = a;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * len * 0.08, a[2] + (b[2] - a[2]) * t];
      this.segment(prev, pt, cam, 0.015, light, env, { tint: [0.12, 0.12, 0.12, 0.85] });
      prev = pt;
    }
  }

  drawSigns(game, cam, env) {
    const w = game.world;
    for (const [key, be] of w.blockEntities) {
      if (be.type !== 'sign') continue;
      const [x, y, z] = key.split(',').map(Number);
      const dx = x + 0.5 - cam.x, dz = z + 0.5 - cam.z;
      if (dx * dx + dz * dz > 48 * 48) continue;
      const id = w.getBlock(x, y, z);
      if (id !== B.oak_sign && id !== B.oak_wall_sign) continue;
      const meta = w.getMeta(x, y, z);
      const light = this.lightAt(w, x + 0.5, y + 0.5, z + 0.5);
      identity(T);
      if (id === B.oak_sign) {
        translate(T, T, x + 0.5 - cam.x, y - cam.y, z + 0.5 - cam.z);
        rotateY(T, T, Math.PI - (meta & 15) * Math.PI / 8);
        this.r.drawModel(this.signPost, T, 'block', light, env, { blockMode: 1 });
        translate(T, T, 0, 0.78, 0);
      } else {
        const [fx, fz] = DIRS[meta & 3];
        translate(T, T, x + 0.5 - fx * 0.44 - cam.x, y + 0.5 - cam.y, z + 0.5 - fz * 0.44 - cam.z);
        rotateY(T, T, Math.atan2(fx, fz));
      }
      this.r.drawModel(this.signBoard, T, 'block', light, env, { blockMode: 1 });
      if (be.lines && be.lines.some((l) => l)) {
        M.set(T);
        translate(M, M, 0, 0, 0.046);
        scale(M, M, 0.96, 0.48, 1);
        this.r.drawModel(this.textQuad, M, this.signTexture(key, be.lines), light, env, { blockMode: 0 });
      }
    }
  }

  // Another player in a shared world, with a name tag.
  drawRemote(rp, game, cam, env, alpha) {
    const pos = rp.lerpPos(alpha);
    const dx = pos[0] - cam.x, dz = pos[2] - cam.z;
    if (dx * dx + dz * dz > 128 * 128) return;
    if (rp.bodyYaw === undefined) rp.bodyYaw = rp.yaw;
    const d = rp.yaw - rp.bodyYaw;
    rp.bodyYaw += Math.atan2(Math.sin(d), Math.cos(d)) * 0.25;
    const meshes = this.remoteSkin ? this.remoteSkin(rp) : null;
    this.drawHumanoid(rp, pos, game, cam, env, alpha, rp.swing || 0, rp.held ? { id: rp.held, count: 1 } : null, rp.armor ? rp.armor.map((id) => (id ? { id } : null)) : [null, null, null, null], meshes);
    if (rp.effects && rp.effects.invisibility) return;
    // name tag
    const key = 'tag:' + rp.name;
    let e = this.signTex.get(key);
    if (!e) {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 48;
      const g = c.getContext('2d');
      g.font = 'bold 26px "Pixelify Sans", "Trebuchet MS", sans-serif';
      const wdt = Math.min(250, g.measureText(rp.name).width + 16);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(128 - wdt / 2, 4, wdt, 40);
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(rp.name, 128, 25);
      e = { text: rp.name, tex: this.r.createCanvasTexture(c) };
      this.signTex.set(key, e);
    }
    identity(M);
    translate(M, M, pos[0] - cam.x, pos[1] + 2.15 - cam.y - (rp.sneaking ? 0.2 : 0), pos[2] - cam.z);
    rotateY(M, M, -cam.yaw);
    scale(M, M, 1.6, 0.3, 1);
    this.r.drawModel(this.textQuad, M, e.tex, [1, 1], env, { blockMode: 0, mode: 1, blend: true, noCull: true });
  }

  // First-person hand or held item (view space).
  drawHand(game, env, alpha) {
    const p = game.player;
    if (p.dead || game.perspective !== 0 || game.hideHud || p.sleeping) return;
    const r = this.r;
    const light = this.lightAt(game.world, p.x, p.y + p.eye, p.z);
    const held = p.inventory.held;
    const swing = game.swingProgress(alpha);
    const equip = game.equipProgress(alpha);
    const sq = Math.sin(Math.sqrt(swing) * Math.PI), s2 = Math.sin(swing * swing * Math.PI);
    // gentle sway from walking
    const walk = lerp(p.pWalkDist, p.walkDist, alpha) * Math.PI;
    const bob = game.settings.bobbing ? lerp(p.pbob, p.bob, alpha) : 0;
    const bx = Math.sin(walk) * bob * 0.5, by = -Math.abs(Math.cos(walk) * bob);
    const opts = { mode: 2, proj: r.handProj };
    const eating = game.eatingProgress(alpha);

    identity(M);
    if (!held) {
      // bare arm reaching forward from the lower right
      translate(M, M, 0.62 + bx - sq * 0.18, -0.68 + by - equip * 0.6 + Math.sin(sq * Math.PI) * 0.12, -0.52 - s2 * 0.25);
      rotateY(M, M, 0.42 - sq * 0.35);
      rotateZ(M, M, -0.3 + s2 * 0.15);
      rotateX(M, M, Math.PI / 2 + 0.28 + sq * 0.5);
      scale(M, M, 1 / 16, 1 / 16, 1 / 16);
      translate(M, M, 6, -22, 0);
      r.drawModel(this.models.player.armR, M, 'skin', light, env, opts);
      return;
    }
    const mesh = this.items.get(held.id);
    if (!mesh) return;
    const def = ITEMS[held.id];
    let ex = 0, ey = 0, ez = 0;
    if (game.bowDraw > 0) {
      const f = Math.min(1, (game.bowDraw + alpha) / 20);
      ex = -0.42 * Math.min(1, f * 3); ey = 0.08; ez = 0.1 + f * 0.12;
      if (f >= 1) ex += Math.sin(performance.now() / 30) * 0.004;
    }
    if (eating > 0) {
      ex = -0.35 * Math.min(1, eating * 4); ey = 0.12 * Math.min(1, eating * 4) + Math.abs(Math.sin(eating * 32)) * 0.05; ez = 0.1;
    }
    if (held.id === I.photon_blaster) {
      const kick = Math.max(0, (game.blasterKick || 0) - alpha * 0.25);
      const rl = game.blasterReload > 0 ? Math.sin((1 - (game.blasterReload - alpha) / 26) * Math.PI) : 0;
      translate(M, M, 0.3 + bx, -0.3 + by - equip * 0.6 - rl * 0.12, -0.56 + kick * 0.08);
      rotateY(M, M, 0.05);
      rotateX(M, M, kick * 0.16 - rl * 0.7);
      rotateZ(M, M, rl * 0.6);
      scale(M, M, 0.5, 0.5, 0.5);
      const ch = held.charge === undefined ? 1 : held.charge / 48;
      this.drawBlaster(M, light, env, opts, Math.max(0.15, ch));
      if (game.blasterKick > 0.6) {
        // muzzle flash
        translate(M, M, 0, 1.5 / 16, -12.6 / 16);
        rotateZ(M, M, performance.now() / 40);
        const f = (game.blasterKick - 0.6) * 2.5;
        scale(M, M, 0.22 * f + 0.05, 0.22 * f + 0.05, 0.1);
        r.drawModel(this.unitBox, M, 'block', [1, 1], env, { ...opts, mode: 1, glow: 1, blend: true, alpha: Math.min(1, f + 0.2), tintColor: [0.7, 1, 1], noCull: true });
      }
      return;
    }
    if (held.id === I.shield) {
      const up = p.blocking ? 1 : 0;
      translate(M, M, 0.45 - up * 0.3 + bx, -0.5 + up * 0.18 + by - equip * 0.6, -0.8 + up * 0.15);
      rotateY(M, M, 0.25 - up * 0.2);
      scale(M, M, 0.9, 0.9, 0.9);
      r.drawModel(mesh.model, M, mesh.tex, light, env, { ...opts, blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: true });
      return;
    }
    if (mesh.kind === 'block') {
      translate(M, M, 0.64 + bx - sq * 0.3 + ex, -0.6 + by - equip * 0.6 + Math.sin(sq * Math.PI * 2) * 0.12 + ey, -1.0 - s2 * 0.2 + ez);
      rotateY(M, M, 0.785 - s2 * 0.4);
      rotateX(M, M, 0.12 - sq * 0.6);
      scale(M, M, 0.36, 0.36, 0.36);
      r.drawModel(mesh.model, M, mesh.tex, light, env, { ...opts, blockMode: mesh.blockMode, tintColor: mesh.tint });
    } else {
      const tool = !!def.tool;
      translate(M, M, 0.6 + bx - sq * 0.28 + ex, -0.5 + by - equip * 0.6 + Math.sin(sq * Math.PI * 2) * 0.12 + ey, -0.92 - s2 * 0.2 + ez);
      rotateY(M, M, -0.45 - s2 * 0.5);
      rotateX(M, M, -sq * 1.0);
      rotateZ(M, M, tool ? 0.25 : 0);
      scale(M, M, 0.5, 0.5, 0.5);
      r.drawModel(mesh.model, M, mesh.tex, light, env, { ...opts, blockMode: mesh.blockMode, tintColor: mesh.tint, noCull: true });
    }
  }
}

