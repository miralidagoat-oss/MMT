/** Uniform-grid spatial hash for fast proximity queries (AI, interest management, collision). */
export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  private where = new Map<T, number>();

  constructor(private cellSize: number) {}

  private key(cx: number, cz: number): number {
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  insert(item: T, x: number, z: number): void {
    const k = this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
    const prev = this.where.get(item);
    if (prev === k) return;
    if (prev !== undefined) this.removeFromCell(item, prev);
    let arr = this.cells.get(k);
    if (!arr) { arr = []; this.cells.set(k, arr); }
    arr.push(item);
    this.where.set(item, k);
  }

  remove(item: T): void {
    const prev = this.where.get(item);
    if (prev !== undefined) this.removeFromCell(item, prev);
    this.where.delete(item);
  }

  private removeFromCell(item: T, k: number) {
    const arr = this.cells.get(k);
    if (!arr) return;
    const i = arr.indexOf(item);
    if (i >= 0) { arr[i] = arr[arr.length - 1]!; arr.pop(); }
    if (arr.length === 0) this.cells.delete(k);
  }

  query(x: number, z: number, radius: number, out: T[] = []): T[] {
    const cs = this.cellSize;
    const x0 = Math.floor((x - radius) / cs), x1 = Math.floor((x + radius) / cs);
    const z0 = Math.floor((z - radius) / cs), z1 = Math.floor((z + radius) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(this.key(cx, cz));
        if (arr) for (const it of arr) out.push(it);
      }
    }
    return out;
  }

  clear(): void { this.cells.clear(); this.where.clear(); }
  get size(): number { return this.where.size; }
}
