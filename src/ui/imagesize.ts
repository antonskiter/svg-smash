export interface Sniffed {
  mime: string;
  width: number;
  height: number;
}

const at = (b: Uint8Array, i: number): number => b[i] ?? 0;

const u32be = (b: Uint8Array, i: number): number =>
  ((at(b, i) << 24) | (at(b, i + 1) << 16) | (at(b, i + 2) << 8) | at(b, i + 3)) >>> 0;
const u16be = (b: Uint8Array, i: number): number => (at(b, i) << 8) | at(b, i + 1);
const u16le = (b: Uint8Array, i: number): number => at(b, i) | (at(b, i + 1) << 8);
const u32le = (b: Uint8Array, i: number): number =>
  (at(b, i) | (at(b, i + 1) << 8) | (at(b, i + 2) << 16) | (at(b, i + 3) << 24)) >>> 0;
const u24le = (b: Uint8Array, i: number): number =>
  at(b, i) | (at(b, i + 1) << 8) | (at(b, i + 2) << 16);

const startsWith = (b: Uint8Array, offset: number, sig: readonly number[]): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => at(b, offset + i) === v);

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

const sized = (mime: string, width: number, height: number): Sniffed | null =>
  width > 0 && height > 0 ? { mime, width, height } : null;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(b: Uint8Array): Sniffed | null {
  if (!startsWith(b, 0, PNG_SIG) || b.length < 24) return null;
  return sized('image/png', u32be(b, 16), u32be(b, 20));
}

/** SOF0/1/2/9/10 carry the frame size; every other segment is stepped over by its length. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc9, 0xca]);
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

function sniffJpeg(b: Uint8Array): Sniffed | null {
  if (at(b, 0) !== 0xff || at(b, 1) !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (at(b, i) !== 0xff) {
      i++;
      continue;
    }
    const marker = at(b, i + 1);
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (JPEG_STANDALONE.has(marker)) {
      i += 2;
      continue;
    }
    if (JPEG_SOF.has(marker)) return sized('image/jpeg', u16be(b, i + 7), u16be(b, i + 5));
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');

/** The three WebP chunk layouts, keyed by the fourcc at offset 12. */
const WEBP_CHUNK: Record<string, (b: Uint8Array) => Sniffed | null> = {
  'VP8 ': (b) => sized('image/webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff),
  VP8L: (b) => {
    const bits = u32le(b, 21); // 14 bits width-1, then 14 bits height-1
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  },
  VP8X: (b) => sized('image/webp', u24le(b, 24) + 1, u24le(b, 27) + 1),
};

function sniffWebp(b: Uint8Array): Sniffed | null {
  if (!startsWith(b, 0, RIFF) || !startsWith(b, 8, WEBP) || b.length < 30) return null;
  const fourcc = String.fromCharCode(at(b, 12), at(b, 13), at(b, 14), at(b, 15));
  const read = WEBP_CHUNK[fourcc];
  return read ? read(b) : null;
}

const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');

function sniffGif(b: Uint8Array): Sniffed | null {
  if (!startsWith(b, 0, GIF87) && !startsWith(b, 0, GIF89)) return null;
  if (b.length < 10) return null;
  return sized('image/gif', u16le(b, 6), u16le(b, 8));
}

export const SNIFFERS: ReadonlyArray<(b: Uint8Array) => Sniffed | null> = [
  sniffPng,
  sniffJpeg,
  sniffWebp,
  sniffGif,
];

/** First non-null wins. Magic bytes beat the declared mime. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  for (const sniffer of SNIFFERS) {
    const hit = sniffer(bytes);
    if (hit) return hit;
  }
  return null;
}
