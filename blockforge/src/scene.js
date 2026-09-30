// Draws entities, the third-person player and the first-person hand.
import { mat4, identity, translate, scale, rotateX, rotateY, rotateZ } from './math.js';
import { MODELS, buildModelMeshes, ItemMeshes, OUTFITS } from './models.js';
import { cubeMesh } from './renderer.js';
import { faceTexture, B, TEX } from './blocks.js';
import { ITEMS, I, ARMOR_PIECES } from './items.js';
import { FallingBlock, PrimedCrate, Mob, Projectile, Lightning } from './entities.js';

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
    for (const e of game.entities) {
      const [x, y, z] = e.lerpPos(alpha);
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
      if (dx * dx + dz * dz > 96 * 96 && !(e instanceof Lightning)) continue;
      if (e instanceof Mob) this.drawMob(e, x, y, z, cam, env, alpha, world);
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
    const mesh = this.items.get(e.kind === 'egg' ? I.egg : I.snowball);
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
      this.r.drawModel(this.unitCube, M, 'block', [1, 1], env, { mode: 1 });
      px = nx; pz = nz;
    }
  }

  drawItemEntity(it, x, y, z, cam, env, alpha, world) {
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
      if (!a) continue;
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
      let arm = -0.25 - (e.target ? 0.9 : 0);
      if (e.swing > 0) arm -= Math.sin(((10 - e.swing + alpha) / 10) * Math.PI) * 0.8;
      poses.armR = [arm - sw * 0.5, 0, 0.05]; poses.armL = [arm + sw * 0.5, 0, -0.05];
    }
    if (e.type === 'archer' && e.target) {
      poses.armR = [-Math.PI / 2 + headPitch, -0.1, 0]; poses.armL = [-Math.PI / 2 + headPitch, 0.5, 0];
    }
    if (e.type === 'imp') {
      poses.tail = [0.3, Math.sin((e.age + alpha) * 0.25) * 0.5, 0];
      if (e.swing > 0) poses.armR = [-1.5 * Math.sin(((10 - e.swing + alpha) / 10) * Math.PI), 0, 0.05];
    }
    if (e.type === 'settler' && e.swing > 0) poses.armR = [-1.2, 0, 0];
    const light = e.type === 'imp' ? [0.4, 1] : this.lightAt(world, x, y + def.height * 0.6, z);
    const hurt = e.hurtTime > 0 || e.dead;
    const opts = { tint: hurt ? [0.9, 0.1, 0.1, 0.45] : e.fire > 0 ? [1, 0.5, 0.1, 0.15] : undefined };
    let hidden = e.type === 'sheep' && (e.sheared || e.baby) ? new Set(['wool', 'headWool']) : null;
    let meshes = null;
    if (e.type === 'settler') {
      const prof = e.profession || 'farmer';
      meshes = this.models[`settler:${prof}`] || this.models.settler;
      if (!OUTFITS[prof] || !OUTFITS[prof].hat) hidden = new Set(['brim', 'crown']);
    }
    this.drawParts(e.def.model, poses, T, light, env, opts, hidden, meshes);
    if (e.armor) this.drawArmor(e.def.model, e.armor, poses, T, light, env, opts);
    if (e.type === 'archer') this.drawHeld('archer', I.bow, poses, T, light, env, 'armL', true);
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
      poses.armR = [-1.2 * s - 0.3, -0.3 * s, 0.04];
    }
    return poses;
  }

  drawPlayer(game, cam, env, alpha) {
    const p = game.player;
    const [x, y, z] = p.lerpPos(alpha);
    // body turns toward the look direction when walking
    if (p.bodyYaw === undefined) p.bodyYaw = p.yaw;
    const d = p.yaw - p.bodyYaw;
    const dd = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(dd) > 0.8 || p.bob > 0.01) p.bodyYaw += dd * 0.2;
    identity(T);
    translate(T, T, x - cam.x, y - cam.y - (p.sneaking ? 0.12 : 0), z - cam.z);
    rotateY(T, T, -p.bodyYaw);
    scale(T, T, 0.9375 / 16, 0.9375 / 16, 0.9375 / 16);
    const light = this.lightAt(game.world, x, y + 1, z);
    const poses = this.playerPoses(p, alpha, game.swingProgress(alpha));
    const popts = { tint: p.hurtTime > 0 ? [0.9, 0.1, 0.1, 0.45] : undefined };
    this.drawParts('player', poses, T, light, env, popts);
    const inv = p.inventory;
    const worn = [inv.get(36), inv.get(37), inv.get(38), inv.get(39)].map((st) => (st ? st.id : 0));
    if (worn.some(Boolean)) this.drawArmor('player', worn, poses, T, light, env, popts);
    // held item in the right hand
    const held = p.inventory.held;
    if (held) {
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

