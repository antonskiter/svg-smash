export type ImageAction =
  | 'converted' | 'kept-not-smaller' | 'skipped-unsupported' | 'deduped' | 'failed';

export type SizeSource = 'none' | 'pattern-chain' | 'image-attrs' | 'limits';

/** One `(xlink:)href="data:image/…;base64,…"` occurrence. Produced by scanImages (§4.3),
 *  consumed by the orchestrator and by spliceAll. Offsets are into the *input* string. */
export interface ImageHit {
  index: number;               // 0-based occurrence order
  attr: 'href' | 'xlink:href';
  quote: '"' | "'";
  mime: string;                // 'image/' + subtype, verbatim from the URI, not lower-cased
  uriStart: number;            // offset of the 'd' in 'data:' — the splice start
  uriEnd: number;              // offset one past the last payload character — the splice end
  payloadRaw: string;          // base64 exactly as it appears, whitespace included
}

export interface ImageReport {
  index: number;                 // 0-based occurrence order in the source string
  elementId: string | null;      // id attr of the enclosing tag, if any
  name: string | null;           // data-name attr of the enclosing tag — Figma's own file name
  tagName: string | null;        // enclosing tag name, 'image' in real Figma exports
  attr: 'href' | 'xlink:href';
  mime: string;                  // verbatim from the data URI, e.g. 'image/png'
  sniffedMime: string | null;    // from magic bytes; wins over `mime` on conflict
  originalBytes: number;         // decoded payload length
  newBytes: number;              // === originalBytes for every action except 'converted'
  action: ImageAction;
  reason: string | null;         // slug, e.g. 'mime:image/gif', 'encoder-returned-null'
  boxWidth: number | null;       // <image width> attribute, never modified
  boxHeight: number | null;
  sourceWidth: number | null;    // intrinsic bitmap pixels, from the sniffer
  sourceHeight: number | null;
  downscaledTo: { width: number; height: number } | null;
  sizeSource: SizeSource;
  durationMs: number;
}

export interface TransformOptions {
  quality: number;               // 1..100, clamped
  downscale: boolean;
  pixelRatio?: number;           // default 2 — the "x2" in "displayed size x2"
  maxSide?: number;              // default CANVAS_LIMITS.maxSide
  maxPixels?: number;            // default CANVAS_LIMITS.maxPixels
  perImageTimeoutMs?: number;    // default 20_000
}

export interface TransformResult {
  svg: string;                   // the new SVG, or the input string by identity
  images: ImageReport[];
  originalBytes: number;         // UTF-8 byte length of the input svg
  newBytes: number;              // UTF-8 byte length of the output svg
  encoderCalls: number;          // distinct encoder invocations — the dedupe probe
  warnings: string[];            // document-level oddities, never fatal
  durationMs: number;
}

export interface EncodeInput {
  bytes: Uint8Array;
  mime: string;                                    // sniffed mime
  quality: number;                                 // 1..100
  target: { width: number; height: number } | null; // null = keep intrinsic size
}

export type EncodeOutput =
  | { ok: true; dataUrl: string; bytes: number; width: number; height: number }
  | { ok: false; reason: string };

export interface Encoder { encode(input: EncodeInput): Promise<EncodeOutput>; }

export interface Deps {
  encoder: Encoder;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

export const CANVAS_LIMITS = { maxSide: 65535, maxPixels: 268435456 } as const; // 2^28, measured
export const MIN_TARGET_SIDE = 64;
export const MIN_DOWNSCALE_GAIN = 0.9;   // skip a resample that saves under 10% of the width
export const ASPECT_TOLERANCE = 0.005;   // 0.5%
