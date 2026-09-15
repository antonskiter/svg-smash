import { num, readAttributes } from './scan';
import { ASPECT_TOLERANCE, MIN_DOWNSCALE_GAIN, MIN_TARGET_SIDE } from './types';
import type { SizeSource } from './types';

// ---------------------------------------------------------------- target size

export interface SizingInput {
  sourceWidth: number;
  sourceHeight: number; // intrinsic, from the sniffer
  boxWidth: number | null; // <image width> attr
  displayFactor: number | null; // §4.6, null when unresolved
  downscale: boolean;
  pixelRatio: number;
  maxSide: number;
  maxPixels: number;
}

export interface TargetSize {
  width: number;
  height: number;
  source: SizeSource;
}

export interface TargetResolution {
  target: TargetSize | null;
  reason: 'aspect-drift' | null;
}

/** The hard candidate: never suppressed by the toggle or by any of the three constants. */
function limitsCandidate(i: SizingInput): number | null {
  const s = Math.min(
    1,
    Math.sqrt(i.maxPixels / (i.sourceWidth * i.sourceHeight)),
    i.maxSide / i.sourceWidth,
    i.maxSide / i.sourceHeight,
  );
  return s < 1 ? Math.max(1, Math.floor(i.sourceWidth * s)) : null;
}

/** An SVG scale literal is a truncated decimal — Figma writes `scale(0.0016666667)` for 1/600,
 *  which puts `600 * 0.25 * 2` at 300.000006. Ceiling that raw would buy a pixel of noise, so a
 *  candidate within 1e-6 relative of an integer is that integer. */
const CEIL_TOLERANCE = 1e-6;
const ceilCandidate = (n: number): number => Math.ceil(n - Math.abs(n) * CEIL_TOLERANCE);

/** The optional candidates are bounded in this order, and the order is not free. */
function boundOptional(width: number, sourceWidth: number): number | null {
  const clampedHigh = Math.min(width, sourceWidth);
  if (sourceWidth <= MIN_TARGET_SIDE) return null;
  const clampedLow = Math.max(clampedHigh, MIN_TARGET_SIDE);
  if (clampedLow >= sourceWidth * MIN_DOWNSCALE_GAIN) return null;
  return clampedLow;
}

function candidates(i: SizingInput): Array<{ width: number; source: SizeSource }> {
  const out: Array<{ width: number; source: SizeSource }> = [];
  const limits = limitsCandidate(i);
  if (limits !== null) out.push({ width: limits, source: 'limits' });
  if (!i.downscale || i.boxWidth === null) return out;

  const optional: Array<{ raw: number; source: SizeSource }> = [];
  if (i.displayFactor !== null) {
    optional.push({ raw: ceilCandidate(i.boxWidth * i.displayFactor * i.pixelRatio), source: 'pattern-chain' });
  }
  optional.push({ raw: ceilCandidate(i.boxWidth * i.pixelRatio), source: 'image-attrs' });

  for (const c of optional) {
    if (!Number.isFinite(c.raw) || c.raw < 1) continue;
    const width = boundOptional(c.raw, i.sourceWidth);
    if (width !== null) out.push({ width, source: c.source });
  }
  return out;
}

/** The smallest surviving candidate wins; `limits` keeps its win even against aspect drift. */
export function resolveTarget(i: SizingInput): TargetResolution {
  if (!(i.sourceWidth > 0) || !(i.sourceHeight > 0)) return { target: null, reason: null };

  let winner: { width: number; source: SizeSource } | null = null;
  for (const c of candidates(i)) {
    if (winner === null || c.width < winner.width) winner = c;
  }
  if (winner === null) return { target: null, reason: null };

  const height = Math.max(1, Math.round((winner.width * i.sourceHeight) / i.sourceWidth));
  const drift = Math.abs(winner.width / height / (i.sourceWidth / i.sourceHeight) - 1);
  if (drift > ASPECT_TOLERANCE && winner.source !== 'limits') {
    return { target: null, reason: 'aspect-drift' };
  }
  return { target: { width: winner.width, height, source: winner.source }, reason: null };
}

/** null = keep intrinsic size. */
export function resolveTargetSize(i: SizingInput): TargetSize | null {
  return resolveTarget(i).target;
}

// ------------------------------------------------------- pattern-chain factor

const SVG_ROOT_RE = /<svg\b[^>]*>/i;
const ROOT_WIDTH_RE = /\bwidth\s*=\s*(["'])\s*([\d.]+)\s*(?:px)?\s*\1/i;
const ROOT_VIEWBOX_RE = /\bviewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)/i;
const ANCESTOR_SCALE_RE =
  /<(?!pattern\b|use\b)[A-Za-z][^>]*\btransform\s*=\s*(["'])[^"']*(?:scale|matrix|rotate|skew)/i;
const TRANSFORM_ATTR_RE = /\btransform\s*=\s*(["'])([^"']*)\1/;

const makePatternOpenRe = (): RegExp => /<pattern\b[^>]*\bid\s*=\s*(["'])([^"']*)\1[^>]*>/g;
const makeUseRefRe = (): RegExp => /<use\b[^>]*?(?:xlink:)?href\s*=\s*(["'])#([^"']+)\1[^>]*>/g;
const makeFillRefRe = (): RegExp =>
  /<(rect|circle|ellipse)\b([^>]*?)\bfill\s*=\s*(["'])url\(#([^)"']+)\)\3([^>]*?)\/?>/g;
const makeTransformFnRe = (): RegExp => /([A-Za-z]+)\s*\(([^)]*)\)/g;

const SCALE_OF: Record<string, (n: number[]) => { sx: number } | null> = {
  matrix: (n) => (n.length === 6 && n[1] === 0 && n[2] === 0 && n[0] !== undefined ? { sx: n[0] } : null),
  scale: (n) => (n[0] !== undefined ? { sx: n[0] } : null),
  translate: () => ({ sx: 1 }),
  rotate: () => null,
  skewX: () => null,
  skewY: () => null,
};

const twice = (v: number | null): number | null => (v === null ? null : 2 * v);

const BBOX_WIDTH_OF: Record<string, (a: Record<string, string>) => number | null> = {
  rect: (a) => num(a['width']),
  circle: (a) => twice(num(a['r'])),
  ellipse: (a) => twice(num(a['rx'])),
};

export interface DisplayFactors {
  factors: Map<string, number>;
  warnings: string[];
}

interface PatternUse {
  imageId: string;
  sx: number;
}

function rootScaleX(svg: string): number {
  const root = svg.match(SVG_ROOT_RE)?.[0];
  if (root === undefined) return 1;
  const width = num(root.match(ROOT_WIDTH_RE)?.[2]);
  const viewBoxWidth = num(root.match(ROOT_VIEWBOX_RE)?.[1]);
  if (width === null || viewBoxWidth === null || viewBoxWidth <= 0) return 1;
  return width / viewBoxWidth;
}

/** Product of the sx values in order; null when any function is unresolvable. */
function scaleOfTag(tagText: string): number | null {
  const transform = tagText.match(TRANSFORM_ATTR_RE)?.[2];
  if (transform === undefined) return 1;
  let sx = 1;
  for (const fn of transform.matchAll(makeTransformFnRe())) {
    const step = SCALE_OF[fn[1] ?? ''];
    if (step === undefined) return null;
    const args = (fn[2] ?? '')
      .split(/[\s,]+/)
      .filter((part) => part.length > 0)
      .map(Number);
    if (args.some((n) => !Number.isFinite(n))) return null;
    const scale = step(args);
    if (scale === null) return null;
    sx *= scale.sx;
  }
  return sx;
}

function qualifies(attrs: Record<string, string>): boolean {
  return (
    attrs['patternContentUnits'] === 'objectBoundingBox' &&
    num(attrs['width']) === 1 &&
    num(attrs['height']) === 1 &&
    attrs['patternUnits'] === undefined &&
    attrs['patternTransform'] === undefined
  );
}

function indexPatterns(svg: string, warnings: string[]): Map<string, PatternUse[]> {
  const out = new Map<string, PatternUse[]>();
  for (const m of svg.matchAll(makePatternOpenRe())) {
    const openTag = m[0];
    const id = m[2] ?? '';
    const bodyStart = (m.index ?? 0) + openTag.length;
    const bodyEnd = openTag.endsWith('/>') ? -1 : svg.indexOf('</pattern>', bodyStart);
    const uses = bodyEnd < 0 ? [] : [...svg.slice(bodyStart, bodyEnd).matchAll(makeUseRefRe())];
    if (uses.length === 0) {
      warnings.push('empty-pattern:' + id);
      continue;
    }
    if (!qualifies(readAttributes(openTag))) continue;

    const resolved: PatternUse[] = [];
    for (const use of uses) {
      const sx = scaleOfTag(use[0]);
      if (sx === null) {
        resolved.length = 0;
        break;
      }
      resolved.push({ imageId: use[2] ?? '', sx });
    }
    if (resolved.length > 0) out.set(id, resolved);
  }
  return out;
}

export function resolveDisplayFactorsDetailed(svg: string): DisplayFactors {
  const factors = new Map<string, number>();
  const warnings: string[] = [];
  if (ANCESTOR_SCALE_RE.test(svg)) return { factors, warnings };

  const scale = rootScaleX(svg);
  const patterns = indexPatterns(svg, warnings);

  for (const m of svg.matchAll(makeFillRefRe())) {
    const bboxOf = BBOX_WIDTH_OF[m[1] ?? ''];
    const uses = patterns.get(m[4] ?? '');
    if (bboxOf === undefined || uses === undefined) continue;
    const bboxWidth = bboxOf(readAttributes((m[2] ?? '') + ' ' + (m[5] ?? '')));
    if (bboxWidth === null) continue;
    for (const use of uses) {
      const factor = use.sx * bboxWidth * scale;
      if (!Number.isFinite(factor) || factor <= 0) continue;
      factors.set(use.imageId, Math.max(factors.get(use.imageId) ?? 0, factor));
    }
  }
  return { factors, warnings };
}

/** image id -> max over usages of (sx * bboxWidth * rootScaleX).
 *  displayedWidth = <image width attr> * factor. Empty map when anything is unresolvable. */
export function resolveDisplayFactors(svg: string): Map<string, number> {
  return resolveDisplayFactorsDetailed(svg).factors;
}
