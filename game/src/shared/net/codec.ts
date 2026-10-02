/** Binary message codec (msgpack). Shared by ws transport and worker transport. */
import { Packr, Unpackr } from 'msgpackr';

const packr = new Packr({ useRecords: false, moreTypes: false });
const unpackr = new Unpackr({ useRecords: false, moreTypes: false });

export function encode(msg: unknown): Uint8Array {
  return packr.pack(msg);
}

export function decode<T = unknown>(data: Uint8Array | ArrayBuffer): T {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return unpackr.unpack(u8) as T;
}
