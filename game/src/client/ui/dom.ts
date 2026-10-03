/** Minimal DOM builder used by the UI (no framework). */
type Attrs = Record<string, unknown> & { class?: string; style?: string; text?: string; html?: string; on?: Record<string, (e: Event) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function clear(el: HTMLElement) { while (el.firstChild) el.removeChild(el.firstChild); }

export function fmtTime(hour: number): string {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
