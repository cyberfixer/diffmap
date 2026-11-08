import { inflateRawSync } from "node:zlib";

/**
 * Read one file out of a zip archive (stored or deflated), using the central
 * directory at the end of the file. Enough for CI artifacts; no zip64.
 */
export function readZipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const entry = b.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entry !== name && !entry.endsWith(`/${name}`)) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    if (method === 0) return new Uint8Array(data);
    if (method === 8) return new Uint8Array(inflateRawSync(data));
    return null;
  }
  return null;
}
