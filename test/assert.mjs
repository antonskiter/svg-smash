// test/assert.mjs — pixel diff, alpha, size and report assertions (§7.6).
// Every number the test judges against lives here or in the bundle; nothing is measured in the DOM.

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const DIFF_BUDGET = {
  lossless: { threshold: 0.02, maxRatio: 0.0005 }, // quality 100 control case
  flat: { threshold: 0.1, maxRatio: 0.02 }, // quality 85, flat art
  photo: { threshold: 0.12, maxRatio: 0.02 }, // quality 85, block-noise fixtures at intrinsic size
  resample: { threshold: 0.12, maxRatio: 0.1 }, // downscale-on: a 2x resample moves most pixels slightly
};

const MIN_DRAWN_RATIO = 0.05; // the fixture must actually have drawn something
const ALPHA_LOSSY_TOLERANCE = 2; // a real alpha loss is a jump to 255; 2 is a rounding allowance
const RGBA = 4;

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
const clip = (s, n = 70) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);
const countAction = (r, action) => r.images.filter((i) => i.action === action).length;
const sorted = (xs) => [...xs].map(String).sort();
const sameMultiset = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const eq = (label, got, want) => (got === want ? null : `${label}: ${show(got)}, want ${show(want)}`);

// ---------------------------------------------------------------------------
// Case-table fields (§7.4). One implementation per field, selected by key.
// ---------------------------------------------------------------------------

const EXPECT_CHECKS = {
  converted: (r, v) => eq('converted', countAction(r, 'converted'), v),
  skipped: (r, v) => eq('skipped-unsupported', countAction(r, 'skipped-unsupported'), v),
  deduped: (r, v) => eq('deduped', countAction(r, 'deduped'), v),
  failed: (r, v) => eq('failed', countAction(r, 'failed'), v),
  images: (r, v) => eq('images.length', r.images.length, v),
  encoderCalls: (r, v) => eq('encoderCalls', r.encoderCalls, v),
  identical: (r, v) => eq('identical', r.identical, v),
  maxNewRatio: (r, v) =>
    r.newBytes / r.originalBytes <= v
      ? null
      : `maxNewRatio: measured ${(r.newBytes / r.originalBytes).toFixed(4)} > ${v}`,
  sizeSource: (r, v) => {
    const bad = r.images.filter((i) => i.action === 'converted' && i.sizeSource !== v);
    return bad.length === 0
      ? null
      : `sizeSource: image ${bad.map((i) => `#${i.index}=${show(i.sizeSource)}`).join(', ')}, want ${show(v)}`;
  },
  downscaled: (r, v) => {
    const bad = r.images.filter(
      (i) =>
        i.action === 'converted' &&
        (i.downscaledTo !== null && i.downscaledTo.width < i.sourceWidth) !== v,
    );
    return bad.length === 0
      ? null
      : `downscaled: image ${bad.map((i) => `#${i.index}=${JSON.stringify(i.downscaledTo)}`).join(', ')}, want ${v}`;
  },
  downscaledWidths: (r, v) => {
    const got = r.images.filter((i) => i.downscaledTo !== null).map((i) => i.downscaledTo.width);
    return sameMultiset(got, v) ? null : `downscaledWidths: [${got}], want [${v}]`;
  },
  names: (r, v) => eq('names', JSON.stringify(r.images.map((i) => i.name)), JSON.stringify(v)),
  slugs: (r, v) => {
    const got = r.images.filter((i) => i.reason !== null).map((i) => i.reason);
    return sameMultiset(got, v) ? null : `slugs: [${sorted(got)}], want [${sorted(v)}]`;
  },
  containsVerbatim: (r, v) => {
    const missing = v.filter((_, i) => !r.contains[i]);
    return missing.length === 0 ? null : `missing verbatim: ${missing.map((s) => clip(s)).join(' | ')}`;
  },
  absent: (r, v) => {
    const present = v.filter((_, i) => r.absentHits[i]);
    return present.length === 0 ? null : `must not appear: ${present.map((s) => clip(s)).join(' | ')}`;
  },
};

export function expectFailures(result, expect) {
  return Object.entries(expect)
    .map(([key, want]) =>
      EXPECT_CHECKS[key] ? EXPECT_CHECKS[key](result, want) : `unknown expect field ${key}`,
    )
    .filter((m) => m !== null);
}

// ---------------------------------------------------------------------------
// Invariants asserted on every case, whatever the table says (§4.9, §4.10, §7.6).
// ---------------------------------------------------------------------------

const REASON_REQUIRED = new Set(['failed', 'skipped-unsupported', 'kept-not-smaller']);
const SUCCESS_ACTIONS = new Set(['converted', 'deduped']);

export function invariantFailures(result, consts) {
  const out = [];
  if (result.encoderCalls !== result.wrapperCalls) {
    out.push(`encoderCalls ${result.encoderCalls} !== wrapperCalls ${result.wrapperCalls}`);
  }
  for (const im of result.images) {
    const tag = `image #${im.index}`;
    if (REASON_REQUIRED.has(im.action) && im.reason === null) out.push(`${tag}: ${im.action} without a reason`);
    // a successful report may carry exactly one slug: aspect-drift, explaining a missing downscale
    if (SUCCESS_ACTIONS.has(im.action) && im.reason !== null && !(im.reason === 'aspect-drift' && im.sizeSource === 'none')) {
      out.push(`${tag}: ${im.action} carries reason ${show(im.reason)} with sizeSource ${show(im.sizeSource)}`);
    }
    if (im.action === 'converted' && !(im.newBytes < im.originalBytes)) {
      out.push(`${tag}: converted but ${im.newBytes} >= ${im.originalBytes} bytes`);
    }
    if (im.action === 'deduped' && !(result.outputFirstSame[im.index] < im.index)) {
      out.push(`${tag}: deduped but its output payload matches no earlier occurrence`);
    }
    if (im.downscaledTo !== null && im.sizeSource !== 'limits' && im.sourceWidth && im.sourceHeight) {
      const drift = Math.abs(
        im.downscaledTo.width / im.downscaledTo.height / (im.sourceWidth / im.sourceHeight) - 1,
      );
      if (drift > consts.ASPECT_TOLERANCE) {
        out.push(`${tag}: aspect drift ${drift.toFixed(5)} > ${consts.ASPECT_TOLERANCE}`);
      }
    }
  }
  if (countAction(result, 'converted') > 0 && !(result.newBytes < result.originalBytes)) {
    out.push(`document: ${result.newBytes} >= ${result.originalBytes} bytes despite a conversion`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pixels and alpha
// ---------------------------------------------------------------------------

function nonTransparentRatio(png) {
  let n = 0;
  for (let i = 3; i < png.data.length; i += RGBA) if (png.data[i] !== 0) n += 1;
  return n / (png.width * png.height);
}

function alphaDelta(a, b) {
  let max = 0;
  let count = 0;
  for (let i = 3; i < a.data.length; i += RGBA) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > 0) count += 1;
    if (d > max) max = d;
  }
  return { max, count };
}

function alphaFailures(a, b, { exact, probes }) {
  const out = [];
  for (const [label, png] of [['original', a], ['output', b]]) {
    if (png.colorType !== 6) out.push(`${label} screenshot is colorType ${png.colorType}, not 6 (RGBA)`);
  }
  const d = alphaDelta(a, b);
  if (exact && d.count !== 0) out.push(`alpha: ${d.count} pixels changed (max ${d.max}), must be exact`);
  if (!exact && d.max > ALPHA_LOSSY_TOLERANCE) out.push(`alpha: max delta ${d.max} > ${ALPHA_LOSSY_TOLERANCE}`);
  for (const p of probes) {
    const i = (p.y * a.width + p.x) * RGBA + 3;
    if (a.data[i] !== 0) out.push(`fixture probe (${p.x},${p.y}) is not transparent in the original`);
    if (b.data[i] !== 0) out.push(`alpha probe (${p.x},${p.y}) reads ${b.data[i]}, must be 0`);
  }
  return out;
}

/**
 * Renders' comparison plus the four anti-tautology guards of §7.6.
 * Returns { failures, diffRatio, diffPng }.
 */
export function pixelFailures({ originalBuf, outputBuf, budget, size, probes = [] }) {
  const a = PNG.sync.read(originalBuf);
  const b = PNG.sync.read(outputBuf);

  const truncated = [['original', a], ['output', b]]
    .filter(([, png]) => png.width !== size.width || png.height !== size.height)
    .map(([label, png]) => `screenshot truncated to viewport: ${label} is ${png.width}x${png.height}, want ${size.width}x${size.height}`);
  if (truncated.length > 0) return { failures: truncated, diffRatio: null, diffPng: null };

  const failures = [];
  const drawn = nonTransparentRatio(a);
  if (!(drawn > MIN_DRAWN_RATIO)) {
    failures.push(`original drew nothing: non-transparent ratio ${drawn.toFixed(4)} <= ${MIN_DRAWN_RATIO}`);
  }

  const limits = DIFF_BUDGET[budget];
  if (!limits) return { failures: [...failures, `unknown budget ${show(budget)}`], diffRatio: null, diffPng: null };

  const diffPng = new PNG({ width: size.width, height: size.height });
  const differing = pixelmatch(a.data, b.data, diffPng.data, size.width, size.height, {
    threshold: limits.threshold,
    includeAA: false, // antialiasing detection stays on
  });
  const diffRatio = differing / (size.width * size.height);

  if (diffRatio === 1) failures.push('WebP did not decode: every pixel differs');
  else if (diffRatio > limits.maxRatio) {
    failures.push(`diff ratio ${diffRatio.toFixed(5)} > ${limits.maxRatio} (budget ${budget}, threshold ${limits.threshold})`);
  }
  failures.push(...alphaFailures(a, b, { exact: budget === 'lossless', probes }));

  return { failures, diffRatio, diffPng };
}

// ---------------------------------------------------------------------------
// Pure-function cases (§7.6) — inside the page, against the same bundle.
// ---------------------------------------------------------------------------

const purePage = ({ names, unique, b64, sizing }) => {
  const S = window.SvgSmash;
  const out = { sanitizeName: [], uniqueName: [], base64ByteLength: [], resolveTargetSize: [] };
  const j = (v) => JSON.stringify(v);

  for (const c of names) {
    const got = S.sanitizeName(c.raw);
    if (got !== c.expect) out.sanitizeName.push(`sanitizeName(${j(c.raw)}) = ${j(got)}, want ${j(c.expect)}`);
  }
  for (const c of unique) {
    const seen = new Set();
    const got = c.names.map((n) => S.uniqueName(n, seen));
    if (j(got) !== j(c.expect)) out.uniqueName.push(`uniqueName(${j(c.names)}) = ${j(got)}, want ${j(c.expect)}`);
  }
  for (const c of b64) {
    const got = S.base64ByteLength(c.b64);
    if (got !== c.expect) out.base64ByteLength.push(`base64ByteLength(${j(c.b64)}) = ${got}, want ${c.expect}`);
  }

  const CHECKS = {
    result: (got, want) => (want === null ? got === null : got !== null),
    source: (got, want) => got !== null && got.source === want,
    width: (got, want) => got !== null && got.width === want,
    height: (got, want) => got !== null && got.height === want,
    minRatio: (got, want, input) => got !== null && got.width / input.sourceWidth >= want,
    maxRatio: (got, want, input) => got !== null && got.width / input.sourceWidth <= want,
    underLimits: (got, want, input) =>
      got !== null &&
      (got.width <= input.maxSide && got.height <= input.maxSide && got.width * got.height <= input.maxPixels) === want,
  };
  for (const c of sizing) {
    const input = { ...c.input, maxSide: S.CANVAS_LIMITS.maxSide, maxPixels: S.CANVAS_LIMITS.maxPixels };
    const got = S.resolveTargetSize(input);
    for (const [key, want] of Object.entries(c.expect)) {
      if (!CHECKS[key]) out.resolveTargetSize.push(`${c.id}: unknown expect field ${key}`);
      else if (!CHECKS[key](got, want, input)) {
        out.resolveTargetSize.push(`${c.id}: ${key} unsatisfied — got ${j(got)}, want ${j(want)}`);
      }
    }
  }
  return out;
};

/** Returns one row per pure-function table: { name, ok, detail }. */
export async function runPureCases(page, tables) {
  const found = await page.evaluate(purePage, tables);
  return Object.entries(found).map(([name, failures]) => ({
    name: `pure:${name}`,
    ok: failures.length === 0,
    detail: failures.join(' | '),
  }));
}
