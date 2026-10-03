/**
 * Procedural item icons (ASSET REPLACEMENT POINT: map item ids to image URLs in
 * ICON_OVERRIDES to use painted icons instead).
 */
import { ITEMS } from '../../shared/defs/items';

export const ICON_OVERRIDES: Record<string, string> = {};
const cache = new Map<string, string>();

export function iconFor(id: string): string {
  if (ICON_OVERRIDES[id]) return ICON_OVERRIDES[id]!;
  const c = cache.get(id);
  if (c) return c;
  const def = ITEMS[id];
  const url = draw(def?.icon.shape ?? 'blob', def?.icon.color ?? '#ccc', def?.icon.accent);
  cache.set(id, url);
  return url;
}

function draw(shape: string, color: string, accent?: string): string {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const shade = (hex: string, k: number) => {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.max(0, ((n >> 16) & 255) * k)), gg = Math.min(255, Math.max(0, ((n >> 8) & 255) * k)), b = Math.min(255, Math.max(0, (n & 255) * k));
    return `rgb(${r | 0},${gg | 0},${b | 0})`;
  };
  const fillGrad = (x0: number, y0: number, x1: number, y1: number, col: string) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, shade(col, 1.35)); gr.addColorStop(1, shade(col, 0.7));
    return gr;
  };
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 4; g.shadowOffsetY = 2;
  const wood = '#9a6b3c';
  const handle = () => { g.strokeStyle = fillGrad(0, 0, 64, 64, accent ?? wood); g.lineWidth = 6; g.beginPath(); g.moveTo(18, 54); g.lineTo(44, 14); g.stroke(); };
  switch (shape) {
    case 'stick': g.strokeStyle = fillGrad(0, 0, 64, 64, color); g.lineWidth = 6; g.beginPath(); g.moveTo(12, 52); g.lineTo(52, 12); g.moveTo(32, 32); g.lineTo(44, 40); g.stroke(); if (accent) { g.fillStyle = accent; g.beginPath(); g.arc(50, 14, 6, 0, 7); g.fill(); } break;
    case 'log': g.fillStyle = fillGrad(0, 18, 0, 46, color); g.fillRect(10, 20, 44, 24); g.fillStyle = '#d9b07a'; g.beginPath(); g.ellipse(54, 32, 6, 12, 0, 0, 7); g.fill(); g.strokeStyle = '#7a4f2a'; g.lineWidth = 1.5; g.beginPath(); g.ellipse(54, 32, 3, 7, 0, 0, 7); g.stroke(); break;
    case 'plank': g.fillStyle = fillGrad(0, 20, 0, 44, color); g.save(); g.translate(32, 32); g.rotate(-0.5); g.fillRect(-26, -8, 52, 16); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.moveTo(-22, -2); g.lineTo(22, -2); g.stroke(); g.restore(); break;
    case 'leaf': g.fillStyle = fillGrad(10, 10, 54, 54, color); g.beginPath(); g.moveTo(10, 54); g.quadraticCurveTo(10, 10, 54, 10); g.quadraticCurveTo(54, 54, 10, 54); g.fill(); g.strokeStyle = shade(color, 1.5); g.lineWidth = 2; g.beginPath(); g.moveTo(12, 52); g.lineTo(50, 14); g.stroke(); break;
    case 'fiber': g.strokeStyle = color; g.lineWidth = 2.5; for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(14 + i * 6, 54); g.quadraticCurveTo(20 + i * 5, 30, 10 + i * 7, 10); g.stroke(); } break;
    case 'rope': g.strokeStyle = color; g.lineWidth = 6; g.beginPath(); g.arc(32, 32, 17, 0, Math.PI * 1.8); g.stroke(); g.strokeStyle = shade(color, 0.7); g.lineWidth = 2; g.setLineDash([3, 4]); g.beginPath(); g.arc(32, 32, 17, 0, Math.PI * 1.8); g.stroke(); g.setLineDash([]); break;
    case 'stone': case 'pearl': g.fillStyle = (() => { const r = g.createRadialGradient(26, 24, 2, 32, 34, 24); r.addColorStop(0, shade(color, 1.5)); r.addColorStop(1, shade(color, 0.65)); return r; })(); g.beginPath(); g.moveTo(14, 40); g.quadraticCurveTo(10, 18, 30, 14); g.quadraticCurveTo(54, 12, 52, 36); g.quadraticCurveTo(50, 52, 30, 52); g.quadraticCurveTo(16, 52, 14, 40); g.fill(); break;
    case 'shard': g.fillStyle = fillGrad(16, 10, 50, 54, color); g.beginPath(); g.moveTo(32, 8); g.lineTo(50, 40); g.lineTo(30, 56); g.lineTo(16, 34); g.closePath(); g.fill(); if (accent) { g.fillStyle = accent; g.beginPath(); g.arc(46, 16, 5, 0, 7); g.fill(); } break;
    case 'blob': case 'drop': case 'powder': g.fillStyle = fillGrad(14, 14, 50, 50, color); g.beginPath(); if (shape === 'drop') { g.moveTo(32, 10); g.quadraticCurveTo(52, 36, 32, 54); g.quadraticCurveTo(12, 36, 32, 10); } else g.ellipse(32, 36, 20, 15, 0, 0, 7); g.fill(); break;
    case 'brick': g.fillStyle = fillGrad(0, 20, 0, 46, color); g.fillRect(10, 22, 44, 22); g.strokeStyle = 'rgba(255,255,255,0.25)'; g.strokeRect(10, 22, 44, 22); break;
    case 'ingot': g.fillStyle = fillGrad(0, 20, 0, 46, color); g.beginPath(); g.moveTo(16, 24); g.lineTo(48, 24); g.lineTo(56, 42); g.lineTo(8, 42); g.closePath(); g.fill(); break;
    case 'scrap': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.moveTo(10, 30); g.lineTo(30, 14); g.lineTo(44, 22); g.lineTo(54, 18); g.lineTo(50, 44); g.lineTo(26, 52); g.closePath(); g.fill(); g.fillStyle = '#8a4a2a'; g.beginPath(); g.arc(36, 36, 5, 0, 7); g.fill(); break;
    case 'cloth': case 'hide': case 'bandage': case 'map': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.moveTo(12, 16); g.quadraticCurveTo(32, 10, 52, 16); g.lineTo(50, 50); g.quadraticCurveTo(32, 56, 14, 50); g.closePath(); g.fill(); if (shape === 'map') { g.strokeStyle = accent ?? '#6b4527'; g.lineWidth = 2; g.beginPath(); g.moveTo(20, 40); g.quadraticCurveTo(30, 22, 44, 30); g.stroke(); } if (shape === 'bandage') { g.strokeStyle = '#d64545'; g.lineWidth = 4; g.beginPath(); g.moveTo(32, 22); g.lineTo(32, 44); g.moveTo(21, 33); g.lineTo(43, 33); g.stroke(); } break;
    case 'bone': case 'tooth': g.fillStyle = color; g.beginPath(); if (shape === 'tooth') { g.moveTo(20, 16); g.lineTo(44, 16); g.lineTo(32, 54); } else { g.ellipse(32, 32, 22, 5, -0.7, 0, 7); g.moveTo(16, 46); g.arc(14, 46, 6, 0, 7); g.arc(48, 18, 6, 0, 7); } g.fill(); break;
    case 'shell': case 'coral': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.moveTo(32, 54); g.lineTo(10, 26); g.quadraticCurveTo(32, 6, 54, 26); g.closePath(); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.2)'; for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(32, 52); g.lineTo(14 + i * 9, 22); g.stroke(); } break;
    case 'chip': g.fillStyle = color; g.fillRect(14, 14, 36, 36); g.strokeStyle = '#d9c25a'; g.lineWidth = 2; for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(14, 20 + i * 8); g.lineTo(6, 20 + i * 8); g.moveTo(50, 20 + i * 8); g.lineTo(58, 20 + i * 8); g.stroke(); } break;
    case 'battery': g.fillStyle = fillGrad(0, 0, 64, 0, color); g.fillRect(16, 14, 32, 42); g.fillStyle = '#333'; g.fillRect(26, 8, 12, 6); g.fillStyle = '#111'; g.font = 'bold 18px sans-serif'; g.fillText('+', 26, 40); break;
    case 'antenna': case 'core': g.strokeStyle = color; g.lineWidth = 3; g.beginPath(); g.moveTo(32, 56); g.lineTo(32, 12); g.moveTo(20, 24); g.lineTo(44, 24); g.moveTo(24, 36); g.lineTo(40, 36); g.stroke(); if (shape === 'core') { g.fillStyle = color; g.beginPath(); g.arc(32, 32, 14, 0, 7); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 5, 0, 7); g.fill(); } break;
    case 'axe': handle(); g.fillStyle = fillGrad(30, 6, 56, 30, color); g.beginPath(); g.moveTo(36, 10); g.quadraticCurveTo(58, 8, 54, 30); g.lineTo(40, 22); g.closePath(); g.fill(); break;
    case 'pick': handle(); g.strokeStyle = fillGrad(20, 8, 60, 30, color); g.lineWidth = 6; g.beginPath(); g.moveTo(24, 10); g.quadraticCurveTo(44, 8, 58, 26); g.stroke(); break;
    case 'hammer': handle(); g.fillStyle = fillGrad(30, 6, 56, 26, color); g.save(); g.translate(44, 16); g.rotate(-1); g.fillRect(-14, -7, 28, 14); g.restore(); break;
    case 'blade': g.strokeStyle = accent ?? wood; g.lineWidth = 6; g.beginPath(); g.moveTo(14, 54); g.lineTo(22, 44); g.stroke(); g.fillStyle = fillGrad(20, 10, 54, 46, color); g.beginPath(); g.moveTo(22, 44); g.lineTo(52, 8); g.lineTo(28, 46); g.closePath(); g.fill(); break;
    case 'spear': case 'arrow': g.strokeStyle = shape === 'arrow' ? color : (color ?? wood); g.lineWidth = shape === 'arrow' ? 3 : 4; g.beginPath(); g.moveTo(10, 56); g.lineTo(50, 14); g.stroke(); g.fillStyle = accent ?? '#8d8d86'; g.beginPath(); g.moveTo(56, 8); g.lineTo(44, 14); g.lineTo(50, 20); g.closePath(); g.fill(); break;
    case 'bow': g.strokeStyle = color; g.lineWidth = 5; g.beginPath(); g.arc(14, 32, 30, -1.1, 1.1); g.stroke(); g.strokeStyle = accent ?? '#ddd'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(27, 5); g.lineTo(27, 59); g.stroke(); break;
    case 'rod': g.strokeStyle = color; g.lineWidth = 3; g.beginPath(); g.moveTo(10, 56); g.lineTo(54, 8); g.stroke(); g.strokeStyle = '#eee'; g.lineWidth = 1; g.beginPath(); g.moveTo(54, 8); g.quadraticCurveTo(58, 36, 50, 50); g.stroke(); break;
    case 'torch': case 'lantern': g.strokeStyle = wood; g.lineWidth = 6; g.beginPath(); g.moveTo(26, 56); g.lineTo(34, 26); g.stroke(); g.fillStyle = (() => { const r = g.createRadialGradient(36, 18, 1, 36, 20, 14); r.addColorStop(0, '#fff6c0'); r.addColorStop(0.5, accent ?? '#ff9a2a'); r.addColorStop(1, 'rgba(255,80,0,0)'); return r; })(); g.beginPath(); g.arc(36, 18, 14, 0, 7); g.fill(); break;
    case 'pot': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.moveTo(18, 18); g.lineTo(46, 18); g.quadraticCurveTo(58, 40, 44, 54); g.lineTo(20, 54); g.quadraticCurveTo(6, 40, 18, 18); g.fill(); if (accent) { g.fillStyle = accent; g.fillRect(20, 20, 24, 4); } break;
    case 'coconut': g.fillStyle = (() => { const r = g.createRadialGradient(26, 26, 2, 32, 34, 24); r.addColorStop(0, '#8a6440'); r.addColorStop(1, color); return r; })(); g.beginPath(); g.ellipse(32, 34, 19, 21, 0, 0, 7); g.fill(); if (accent) { g.fillStyle = accent; g.beginPath(); g.ellipse(32, 18, 9, 4, 0, 0, 7); g.fill(); } break;
    case 'skin': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.ellipse(32, 38, 16, 18, 0, 0, 7); g.fill(); g.fillRect(28, 12, 8, 10); break;
    case 'compass': g.fillStyle = color; g.beginPath(); g.arc(32, 32, 22, 0, 7); g.fill(); g.strokeStyle = '#555'; g.lineWidth = 2; g.stroke(); g.fillStyle = accent ?? '#d64545'; g.beginPath(); g.moveTo(32, 14); g.lineTo(37, 32); g.lineTo(27, 32); g.fill(); g.fillStyle = '#333'; g.beginPath(); g.moveTo(32, 50); g.lineTo(37, 32); g.lineTo(27, 32); g.fill(); break;
    case 'spyglass': g.strokeStyle = color; g.lineWidth = 10; g.beginPath(); g.moveTo(14, 48); g.lineTo(50, 16); g.stroke(); g.strokeStyle = accent ?? '#6b4527'; g.lineWidth = 6; g.beginPath(); g.moveTo(28, 36); g.lineTo(36, 29); g.stroke(); break;
    case 'berry': for (const [x, y] of [[26, 30], [38, 28], [32, 40], [22, 42], [42, 40]] as const) { g.fillStyle = (() => { const r = g.createRadialGradient(x! - 3, y! - 3, 1, x!, y!, 8); r.addColorStop(0, shade(color, 1.6)); r.addColorStop(1, color); return r; })(); g.beginPath(); g.arc(x!, y!, 7, 0, 7); g.fill(); } g.fillStyle = '#3f7a2a'; g.beginPath(); g.ellipse(32, 18, 10, 4, -0.3, 0, 7); g.fill(); break;
    case 'root': case 'seed': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.ellipse(32, 36, shape === 'seed' ? 10 : 16, shape === 'seed' ? 13 : 19, 0.4, 0, 7); g.fill(); g.strokeStyle = '#4a7a2a'; g.lineWidth = 3; g.beginPath(); g.moveTo(32, 20); g.quadraticCurveTo(36, 10, 44, 8); g.stroke(); break;
    case 'meat': case 'fish': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); if (shape === 'fish') { g.ellipse(30, 32, 20, 11, 0, 0, 7); g.moveTo(48, 32); g.lineTo(60, 22); g.lineTo(60, 42); } else { g.moveTo(14, 36); g.quadraticCurveTo(16, 14, 40, 16); g.quadraticCurveTo(56, 22, 50, 40); g.quadraticCurveTo(34, 56, 14, 36); } g.fill(); if (shape === 'meat') { g.fillStyle = '#f1e6d0'; g.beginPath(); g.ellipse(46, 44, 5, 4, 0, 0, 7); g.fill(); } else { g.fillStyle = '#111'; g.beginPath(); g.arc(18, 29, 2, 0, 7); g.fill(); } break;
    case 'can': g.fillStyle = fillGrad(0, 0, 64, 0, color); g.fillRect(18, 16, 28, 36); g.fillStyle = '#c94'; g.fillRect(18, 26, 28, 14); g.fillStyle = shade(color, 1.3); g.beginPath(); g.ellipse(32, 16, 14, 4, 0, 0, 7); g.fill(); break;
    case 'splint': g.fillStyle = color; g.fillRect(16, 10, 8, 44); g.fillRect(40, 10, 8, 44); g.fillStyle = '#efe9dc'; g.fillRect(12, 22, 40, 6); g.fillRect(12, 38, 40, 6); break;
    case 'hat': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.ellipse(32, 40, 26, 8, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(32, 30, 14, 14, 0, Math.PI, 0); g.fill(); break;
    case 'goggles': g.strokeStyle = accent ?? '#333'; g.lineWidth = 4; g.beginPath(); g.moveTo(6, 32); g.lineTo(58, 32); g.stroke(); g.fillStyle = color; g.beginPath(); g.arc(22, 32, 10, 0, 7); g.arc(42, 32, 10, 0, 7); g.fill(); break;
    case 'vest': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.moveTo(18, 10); g.lineTo(28, 16); g.lineTo(36, 16); g.lineTo(46, 10); g.lineTo(52, 54); g.lineTo(12, 54); g.closePath(); g.fill(); break;
    case 'pack': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.roundRect(14, 14, 36, 42, 8); g.fill(); g.fillStyle = shade(color, 0.7); g.fillRect(18, 30, 28, 14); break;
    case 'flippers': g.fillStyle = fillGrad(0, 0, 64, 64, color); g.beginPath(); g.moveTo(14, 12); g.lineTo(26, 12); g.lineTo(30, 56); g.lineTo(6, 56); g.closePath(); g.moveTo(38, 12); g.lineTo(50, 12); g.lineTo(58, 56); g.lineTo(34, 56); g.closePath(); g.fill(); break;
    default: g.fillStyle = color; g.beginPath(); g.arc(32, 32, 18, 0, 7); g.fill();
  }
  return cv.toDataURL();
}
