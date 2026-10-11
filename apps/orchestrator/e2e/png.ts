// A tiny PNG encoder for the live-shape e2e lane: Apply's fake screenshots are real images, so the
// in-app viewer renders them (the record's magic-byte check alone would accept a 16-byte stub).
import { crc32, deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgb;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** An RGB PNG of `width` × `height` on `background`, with filled boxes painted in order. */
export function encodePng(width: number, height: number, background: Rgb, boxes: readonly Box[] = []): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(background, y * row + 1 + x * 3);
  }
  for (const b of boxes) {
    for (let y = Math.max(0, b.y); y < Math.min(height, b.y + b.h); y++) {
      for (let x = Math.max(0, b.x); x < Math.min(width, b.x + b.w); x++) raw.set(b.color, y * row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A form-like page: a header bar in `accent`, label/field rows and a button. */
export function fakeFormScreenshot(accent: Rgb, rows = 5): Buffer {
  const boxes: Box[] = [{ x: 0, y: 0, w: 640, h: 56, color: accent }];
  for (let i = 0; i < rows; i++) {
    const y = 88 + i * 52;
    boxes.push({ x: 40, y, w: 140, h: 10, color: [120, 120, 130] });
    boxes.push({ x: 40, y: y + 16, w: 560, h: 24, color: [228, 230, 236] });
  }
  boxes.push({ x: 40, y: 88 + rows * 52 + 8, w: 160, h: 36, color: accent });
  return encodePng(640, 400, [250, 250, 252], boxes);
}
