import { B64_CLEAN_RE, b64Valid, base64ByteLength, base64ToBytes } from './base64';
import { sniff } from './imagesize';
import { describeEnclosingTag, recodable, scanImages } from './scan';
import { resolveDisplayFactorsDetailed, resolveTarget } from './sizing';
import { spliceAll } from './splice';
import type { Edit } from './splice';
import { CANVAS_LIMITS } from './types';
import type {
  Deps,
  EncodeInput,
  EncodeOutput,
  Encoder,
  ImageHit,
  ImageReport,
  TransformOptions,
  TransformResult,
} from './types';

export { createCanvasEncoder, createStubEncoder, withCallCount } from './encode-canvas';
export { scanImages } from './scan';
export { RECODABLE, recodable, DATA_IMAGE_HREF_SOURCE } from './scan';
export { CANVAS_LIMITS, MIN_TARGET_SIDE, MIN_DOWNSCALE_GAIN, ASPECT_TOLERANCE } from './types';
export { resolveTargetSize, resolveDisplayFactors } from './sizing';
export { base64ByteLength } from './base64';
export { sanitizeName, uniqueName } from './download';
export type * from './types';

const DEFAULTS = { pixelRatio: 2, perImageTimeoutMs: 20_000 } as const;

/** Identity-comparable: the only EncodeOutput the timer produces. */
const TIMED_OUT: EncodeOutput = { ok: false, reason: 'timeout' };

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function blankReport(hit: ImageHit, tag: ReturnType<typeof describeEnclosingTag>): ImageReport {
  return {
    index: hit.index,
    elementId: tag.elementId,
    name: tag.name,
    tagName: tag.tagName,
    attr: hit.attr,
    mime: hit.mime,
    sniffedMime: null,
    originalBytes: 0,
    newBytes: 0,
    action: 'failed',
    reason: null,
    boxWidth: tag.boxWidth,
    boxHeight: tag.boxHeight,
    sourceWidth: null,
    sourceHeight: null,
    downscaledTo: null,
    sizeSource: 'none',
    durationMs: 0,
  };
}

/** Racing is not cancelling: `settled` stays alive so the caller can await the encoder's
 *  own cleanup before the loop advances to the next image. */
function encodeWithTimeout(
  encoder: Encoder,
  input: EncodeInput,
  timeoutMs: number,
): { result: Promise<EncodeOutput>; settled: Promise<EncodeOutput> } {
  const settled: Promise<EncodeOutput> = encoder
    .encode(input)
    .catch((error: unknown): EncodeOutput => ({ ok: false, reason: String(error) }));

  const result = new Promise<EncodeOutput>((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    void settled.then((out) => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  return { result, settled };
}

export async function transformSvg(
  svg: string,
  options: TransformOptions,
  deps: Deps,
): Promise<TransformResult> {
  if (typeof svg !== 'string') throw new TypeError('transformSvg: svg must be a string');

  const now = deps.now ?? ((): number => Date.now());
  const startedAt = now();
  const originalBytes = utf8Length(svg);
  const hits = scanImages(svg);

  if (hits.length === 0) {
    return {
      svg,
      images: [],
      originalBytes,
      newBytes: originalBytes,
      encoderCalls: 0,
      warnings: [],
      durationMs: now() - startedAt,
    };
  }

  const quality = clamp(Math.round(options.quality), 1, 100);
  const pixelRatio = options.pixelRatio ?? DEFAULTS.pixelRatio;
  const maxSide = options.maxSide ?? CANVAS_LIMITS.maxSide;
  const maxPixels = options.maxPixels ?? CANVAS_LIMITS.maxPixels;
  const timeoutMs = options.perImageTimeoutMs ?? DEFAULTS.perImageTimeoutMs;

  const { factors, warnings } = resolveDisplayFactorsDetailed(svg);
  const cache = new Map<string, Promise<EncodeOutput>>();
  const images: ImageReport[] = [];
  const edits: Edit[] = [];
  let encoderCalls = 0;

  for (const hit of hits) {
    const imageStartedAt = now();
    const report = blankReport(hit, describeEnclosingTag(svg, hit));
    images.push(report);
    let pendingCleanup: Promise<EncodeOutput> | null = null;

    try {
      const clean = hit.payloadRaw.replace(B64_CLEAN_RE, '');
      report.originalBytes = base64ByteLength(clean);
      report.newBytes = report.originalBytes;

      if (clean.length === 0) {
        report.reason = 'empty-payload';
      } else if (!b64Valid(clean)) {
        report.reason = 'bad-base64';
      } else if (!recodable(hit.mime)) {
        report.action = 'skipped-unsupported';
        report.reason = 'mime:' + hit.mime;
      } else {
        const bytes = base64ToBytes(clean);
        const sniffed = sniff(bytes);
        if (sniffed === null) {
          report.reason = 'unrecognized-bitmap';
        } else {
          report.sniffedMime = sniffed.mime;
          report.sourceWidth = sniffed.width;
          report.sourceHeight = sniffed.height;

          if (!recodable(sniffed.mime)) {
            report.action = 'skipped-unsupported';
            report.reason = 'mime-mismatch:' + sniffed.mime;
          } else {
            const sizing = resolveTarget({
              sourceWidth: sniffed.width,
              sourceHeight: sniffed.height,
              boxWidth: report.boxWidth,
              displayFactor: report.elementId === null ? null : (factors.get(report.elementId) ?? null),
              downscale: options.downscale,
              pixelRatio,
              maxSide,
              maxPixels,
            });
            const target = sizing.target;
            const key = `${target ? target.width : 0}:${clean}`;
            const cached = cache.get(key);

            let out: EncodeOutput;
            if (cached !== undefined) {
              out = await cached;
            } else {
              encoderCalls++;
              const input: EncodeInput = {
                bytes,
                mime: sniffed.mime,
                quality,
                target: target === null ? null : { width: target.width, height: target.height },
              };
              const run = encodeWithTimeout(deps.encoder, input, timeoutMs);
              cache.set(key, run.result);
              out = await run.result;
              if (out === TIMED_OUT) pendingCleanup = run.settled;
            }

            if (!out.ok) {
              report.reason = out.reason;
            } else if (out.bytes >= report.originalBytes) {
              report.action = 'kept-not-smaller';
              report.reason = 'not-smaller';
            } else {
              report.action = cached === undefined ? 'converted' : 'deduped';
              report.reason = sizing.reason;
              report.newBytes = out.bytes;
              if (target !== null) {
                report.downscaledTo = { width: target.width, height: target.height };
                report.sizeSource = target.source;
              }
              edits.push({ start: hit.uriStart, end: hit.uriEnd, text: out.dataUrl });
            }
          }
        }
      }
    } catch (error) {
      report.action = 'failed';
      report.reason = String(error);
      report.newBytes = report.originalBytes;
    }

    report.durationMs = now() - imageStartedAt;
    if (pendingCleanup !== null) await pendingCleanup;
    deps.onProgress?.(report.index + 1, hits.length);
  }

  const outSvg = edits.length === 0 ? svg : spliceAll(svg, edits);
  return {
    svg: outSvg,
    images,
    originalBytes,
    newBytes: edits.length === 0 ? originalBytes : utf8Length(outSvg),
    encoderCalls,
    warnings,
    durationMs: now() - startedAt,
  };
}
