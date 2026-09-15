import { sniff } from './imagesize';
import { CANVAS_LIMITS } from './types';
import type { EncodeInput, EncodeOutput, Encoder } from './types';

const WEBP_MIME = 'image/webp';

interface Target {
  width: number;
  height: number;
}

/** Both decoders return the same shape: HTMLImageElement has no close(), and a
 *  conditional bitmap.close() in cleanup would throw after a successful encode. */
interface Decoded {
  drawable: CanvasImageSource;
  close: () => void;
}

async function decodeViaBlobBitmap(blob: Blob, target: Target | null): Promise<Decoded> {
  const bitmap = await createImageBitmap(
    blob,
    target
      ? { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' }
      : undefined,
  );
  return { drawable: bitmap, close: () => bitmap.close() };
}

async function decodeViaImageElement(blob: Blob, _target: Target | null): Promise<Decoded> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { drawable: img, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const DECODERS: ReadonlyArray<{ id: string; run: (b: Blob, t: Target | null) => Promise<Decoded> }> = [
  { id: 'blob-bitmap', run: decodeViaBlobBitmap },
  { id: 'img-element', run: decodeViaImageElement },
];

async function decodeAny(blob: Blob, target: Target | null): Promise<Decoded | null> {
  for (const decoder of DECODERS) {
    try {
      return await decoder.run(blob, target);
    } catch {
      continue;
    }
  }
  return null;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('filereader-failed'));
    reader.readAsDataURL(blob);
  });
}

const clampQuality = (q: number): number => Math.min(100, Math.max(1, Math.round(q)));

/** Intrinsic size when no resample was asked for; the sniffer already ran upstream. */
function sizeOf(input: EncodeInput): Target | null {
  if (input.target) return input.target;
  const sniffed = sniff(input.bytes);
  return sniffed ? { width: sniffed.width, height: sniffed.height } : null;
}

/** Guards before any allocation, each returning a reason rather than throwing. */
function guard(size: Target | null): { width: number; height: number } | string {
  if (size === null) return 'bad-dimensions';
  const { width, height } = size;
  if (!(width >= 1 && height >= 1)) return 'bad-dimensions';
  if (!(width <= CANVAS_LIMITS.maxSide && height <= CANVAS_LIMITS.maxSide)) return 'canvas-side-exceeded';
  if (!(width * height <= CANVAS_LIMITS.maxPixels)) return 'canvas-area-exceeded';
  return { width, height };
}

async function encodeOnCanvas(input: EncodeInput): Promise<EncodeOutput> {
  const size = guard(sizeOf(input));
  if (typeof size === 'string') return { ok: false, reason: size };
  const { width, height } = size;

  let decoded: Decoded | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    // BlobPart excludes SharedArrayBuffer-backed views; a decoded data-URI payload never is one.
    const payload = input.bytes as Uint8Array<ArrayBuffer>;
    decoded = await decodeAny(new Blob([payload], { type: input.mime }), input.target);
    if (decoded === null) return { ok: false, reason: 'decode-failed' };

    canvas = document.createElement('canvas');
    canvas.width = width; // assignment also clears to transparent
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (ctx === null) throw new Error('no-2d-context');
    ctx.drawImage(decoded.drawable, 0, 0, width, height);

    const target = canvas;
    const quality = clampQuality(input.quality) / 100;
    const blob = await new Promise<Blob | null>((resolve) => {
      target.toBlob(resolve, WEBP_MIME, quality);
    });
    if (blob === null) return { ok: false, reason: 'encoder-returned-null' };
    if (blob.type !== WEBP_MIME) return { ok: false, reason: `webp-unsupported:${blob.type}` };
    return { ok: true, dataUrl: await readAsDataUrl(blob), bytes: blob.size, width, height };
  } finally {
    // Memory hygiene: the timeout branch relies on this running before the loop advances.
    decoded?.close();
    if (canvas !== null) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

export function createCanvasEncoder(): Encoder {
  return { encode: encodeOnCanvas };
}

/** Test doubles (§7.4). Selected by name from the case table, so no function crosses page.evaluate. */
export function createStubEncoder(kind: 'bigger' | 'null'): Encoder {
  return {
    encode: async (input: EncodeInput): Promise<EncodeOutput> => {
      if (kind === 'null') return { ok: false, reason: 'encoder-returned-null' };
      const size = sizeOf(input) ?? { width: 1, height: 1 };
      const bytes = input.bytes.length + 1024;
      return {
        ok: true,
        dataUrl: 'data:image/webp;base64,' + 'A'.repeat(Math.ceil(bytes / 3) * 4),
        bytes,
        width: size.width,
        height: size.height,
      };
    },
  };
}

export function withCallCount(e: Encoder): Encoder & { calls: number } {
  const counted = {
    calls: 0,
    encode: (input: EncodeInput): Promise<EncodeOutput> => {
      counted.calls++;
      return e.encode(input);
    },
  };
  return counted;
}
