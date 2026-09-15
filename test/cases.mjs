// test/cases.mjs — the case tables. Data only: run.mjs never branches on a case id.
//
// Row shape (§7.4):
//   { id, svg, options: { quality, downscale? }, encoder: 'canvas'|'bigger'|'null',
//     budget: 'lossless'|'flat'|'photo'|'resample'|null,
//     render: { width, height } | null,
//     expect: { converted?, skipped?, deduped?, failed?, images?, encoderCalls?, identical?,
//               sizeSource?, downscaled?, downscaledWidths?, maxNewRatio?, names?,
//               containsVerbatim?, absent?, slugs? } }
//
// `images` (total report count) and `downscaledWidths` (multiset of converted downscale widths)
// extend §7.4's schema because two rows of its table assert exactly those numbers
// (`images.length === 2` / `=== 0`, `downscaledTo.width === 300`) and nothing else can carry them.
// `names` (the `data-name` per report, in index order) extends it the same way: the UI's image
// label reads that field, and only an ordered list distinguishes it from the id fallback.
//
// Every `maxNewRatio` below is a recorded measurement plus a 15% margin, per §7.4 — never a
// guessed bound. Each is the `new/orig` column the runner printed for that case on Chromium 149
// with these fixtures, times 1.15, rounded up. A row that converts nothing carries none: its
// ratio is 1.0000 by definition and a bound there would assert nothing. The standing size
// assertion (`newBytes < originalBytes`) is enforced for every case by run.mjs regardless.
// Re-record — never relax — after any fixture or encoder change.

import { FIGMA_LIKE_IMAGE_NAME } from './fixtures.mjs';

const webpHead = (head) => head + 'image/webp;base64,';

export function buildCases(svgs) {
  const at = (id) => {
    const doc = svgs[id];
    if (!doc) throw new Error(`no fixture SVG for case ${id}`);
    return doc;
  };
  const render = (id) => ({ width: at(id).width, height: at(id).height });

  return [
    {
      id: 'figma-like',
      svg: at('figma-like').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('figma-like'),
      expect: {
        converted: 2,
        skipped: 1,
        deduped: 0,
        failed: 0,
        images: 3,
        encoderCalls: 2,
        sizeSource: 'none',
        downscaled: false,
        maxNewRatio: 0.887, // measured 0.7708
        slugs: ['mime:image/webp'],
        names: [FIGMA_LIKE_IMAGE_NAME, null, null],
        containsVerbatim: at('figma-like').verbatim.uses,
      },
    },
    {
      id: 'dup-payload',
      svg: at('dup-payload').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('dup-payload'),
      expect: {
        converted: 1,
        deduped: 1,
        skipped: 0,
        failed: 0,
        images: 2,
        encoderCalls: 1,
        maxNewRatio: 0.81, // measured 0.7041
        slugs: [],
      },
    },
    {
      id: 'bare-href',
      svg: at('bare-href').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('bare-href'),
      expect: {
        converted: 1,
        images: 1,
        encoderCalls: 1,
        maxNewRatio: 0.755, // measured 0.6558
        containsVerbatim: ['href="data:image/webp'],
        absent: ['xlink:href'],
        slugs: [],
      },
    },
    {
      id: 'single-quote',
      svg: at('single-quote').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('single-quote'),
      expect: {
        converted: 1,
        images: 1,
        encoderCalls: 1,
        maxNewRatio: 0.755, // measured 0.6558
        containsVerbatim: ["href='data:image/webp"],
        absent: ['xlink:href', 'href="data:'],
        slugs: [],
      },
    },
    {
      id: 'two-per-line',
      svg: at('two-per-line').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('two-per-line'),
      expect: {
        converted: 2,
        images: 2,
        encoderCalls: 2,
        maxNewRatio: 0.632, // measured 0.5495
        containsVerbatim: ['href="data:image/webp', 'xlink:href="data:image/webp'],
        slugs: [],
      },
    },
    {
      id: 'nested-defs',
      svg: at('nested-defs').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('nested-defs'),
      expect: { converted: 1, images: 1, encoderCalls: 1, maxNewRatio: 0.811, slugs: [] }, // measured 0.7050
    },
    {
      id: 'nonsquare',
      svg: at('nonsquare').svg,
      options: { quality: 85, downscale: true },
      encoder: 'canvas',
      budget: 'photo',
      render: render('nonsquare'),
      expect: {
        converted: 1,
        images: 1,
        encoderCalls: 1,
        sizeSource: 'pattern-chain',
        downscaled: true,
        downscaledWidths: [160],
        maxNewRatio: 0.447, // measured 0.3879
        slugs: [],
      },
    },
    {
      id: 'huge',
      svg: at('huge').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'photo',
      render: render('huge'),
      expect: {
        converted: 1,
        images: 1,
        encoderCalls: 1,
        sizeSource: 'none',
        downscaled: false,
        maxNewRatio: 0.946, // measured 0.8223
        slugs: [],
      },
    },
    {
      id: 'lossless',
      svg: at('lossless').svg,
      options: { quality: 100 },
      encoder: 'canvas',
      budget: 'lossless',
      render: render('lossless'),
      // every recodable image converted; a kept-not-smaller would show up as a
      // 'not-smaller' slug and fail the case as "control case degenerate"
      expect: { converted: 1, images: 1, encoderCalls: 1, sizeSource: 'none', maxNewRatio: 0.714, slugs: [] }, // measured 0.6204
    },
    {
      id: 'keep-original',
      svg: at('keep-original').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: null,
      render: null,
      expect: {
        converted: 0,
        images: 1,
        encoderCalls: 1,
        identical: true,
        slugs: ['not-smaller'],
        containsVerbatim: [at('keep-original').verbatim.kept],
      },
    },
    {
      id: 'stub-bigger',
      svg: at('stub-bigger').svg,
      options: { quality: 85 },
      encoder: 'bigger',
      budget: null,
      render: null,
      expect: {
        converted: 0,
        deduped: 0,
        failed: 0,
        skipped: 1,
        images: 3,
        encoderCalls: 2,
        identical: true,
        slugs: ['not-smaller', 'not-smaller', 'mime:image/webp'],
      },
    },
    {
      id: 'stub-null',
      svg: at('stub-null').svg,
      options: { quality: 85 },
      encoder: 'null',
      budget: null,
      render: null,
      expect: {
        converted: 0,
        deduped: 0,
        failed: 2,
        skipped: 1,
        images: 3,
        encoderCalls: 2,
        identical: true,
        slugs: ['encoder-returned-null', 'encoder-returned-null', 'mime:image/webp'],
      },
    },
    {
      id: 'skip-only',
      svg: at('skip-only').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: null,
      render: null,
      expect: {
        converted: 0,
        deduped: 0,
        failed: 0,
        skipped: 4,
        images: 4,
        encoderCalls: 0,
        identical: true,
        slugs: ['mime:image/webp', 'mime:image/gif', 'mime:image/avif', 'mime:image/svg+xml'],
      },
    },
    {
      id: 'no-images',
      svg: at('no-images').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: null,
      render: null,
      expect: {
        converted: 0,
        deduped: 0,
        failed: 0,
        skipped: 0,
        images: 0,
        encoderCalls: 0,
        identical: true,
        slugs: [],
      },
    },
    {
      id: 'malformed',
      svg: at('malformed').svg,
      options: { quality: 85 },
      encoder: 'canvas',
      budget: 'flat',
      render: render('malformed'),
      expect: {
        converted: 1,
        deduped: 0,
        failed: 2,
        skipped: 1,
        images: 4,
        encoderCalls: 1,
        maxNewRatio: 0.835, // measured 0.7259
        slugs: ['bad-base64', 'empty-payload', 'mime-mismatch:image/gif'],
        containsVerbatim: [
          at('malformed').verbatim.truncated,
          at('malformed').verbatim.empty,
          at('malformed').verbatim.gifAsPng,
          at('malformed').verbatim.external,
        ],
        absent: [at('malformed').verbatim.externalRewritten],
      },
    },
    {
      id: 'downscale-on',
      svg: at('downscale-on').svg,
      options: { quality: 85, downscale: true },
      encoder: 'canvas',
      budget: 'resample',
      render: render('downscale-on'),
      expect: {
        converted: 2,
        skipped: 1,
        deduped: 0,
        failed: 0,
        images: 3,
        encoderCalls: 2,
        sizeSource: 'pattern-chain',
        downscaled: true,
        downscaledWidths: [300, 80],
        maxNewRatio: 0.468, // measured 0.4062
        slugs: ['mime:image/webp'],
        // <use transform> and <image width/height> byte-identical to the input
        containsVerbatim: [
          ...at('downscale-on').verbatim.uses,
          webpHead(at('downscale-on').verbatim.imageHeads[0]),
          webpHead(at('downscale-on').verbatim.imageHeads[1]),
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Pure-function tables (§7.6). Executed inside page.evaluate against window.SvgSmash.
// ---------------------------------------------------------------------------

/** sanitizeName: the rules of §5.1 applied in order. */
export const PURE_NAME_CASES = [
  { raw: '../../etc/passwd', expect: '-..-etc-passwd' }, // separators -> '-', then leading dots trimmed
  { raw: 'a\nb', expect: 'ab' }, // \n is a control char, removed before the whitespace rule
  { raw: 'CON', expect: '_CON' },
  { raw: '   ', expect: 'untitled' },
  { raw: '', expect: 'untitled' },
  { raw: 'a'.repeat(400), expect: 'a'.repeat(120) },
  { raw: '🙂', expect: '🙂' },
  { raw: 'Logo.svg', expect: 'Logo.svg' }, // never strips an existing extension
];

/** uniqueName: one shared Set per row, lower-cased keys, counter before '.svg'. */
export const PURE_UNIQUE_CASES = [
  {
    names: ['Frame 1.svg', 'Frame 1.svg', 'frame 1.svg'],
    expect: ['Frame 1.svg', 'Frame 1 (2).svg', 'frame 1 (3).svg'],
  },
];

/** base64ByteLength against payloads whose decoded length Node computes independently. */
export const PURE_B64_CASES = ['', 'QQ==', 'QUI=', 'QUJD', 'QUJDRA==', 'QUJDREU=', 'QUJDREVG'].map((b64) => ({
  b64,
  expect: Buffer.from(b64, 'base64').length,
}));

/** resolveTargetSize. maxSide/maxPixels are filled in-page from SvgSmash.CANVAS_LIMITS. */
export const PURE_SIZING_CASES = [
  {
    id: 'limits-by-area-toggle-off',
    input: { sourceWidth: 20000, sourceHeight: 15000, boxWidth: null, displayFactor: null, downscale: false, pixelRatio: 2 },
    expect: { source: 'limits', minRatio: 0.94, maxRatio: 0.95, underLimits: true },
  },
  {
    id: 'limits-by-side-tall',
    input: { sourceWidth: 1000, sourceHeight: 70000, boxWidth: null, displayFactor: null, downscale: false, pixelRatio: 2 },
    expect: { source: 'limits', underLimits: true },
  },
  {
    id: 'limits-by-side-wide',
    input: { sourceWidth: 100000, sourceHeight: 10, boxWidth: null, displayFactor: null, downscale: false, pixelRatio: 2 },
    expect: { source: 'limits', underLimits: true },
  },
  {
    id: 'tiny-source-toggle-on',
    input: { sourceWidth: 8, sourceHeight: 8, boxWidth: 8, displayFactor: null, downscale: true, pixelRatio: 2 },
    expect: { result: null },
  },
  {
    id: 'genuine-figma-toggle-on',
    input: { sourceWidth: 600, sourceHeight: 400, boxWidth: 600, displayFactor: null, downscale: true, pixelRatio: 2 },
    expect: { result: null },
  },
  {
    id: 'pattern-chain-wins',
    input: { sourceWidth: 600, sourceHeight: 400, boxWidth: 600, displayFactor: 0.25, downscale: true, pixelRatio: 2 },
    expect: { source: 'pattern-chain', width: 300, height: 200 },
  },
  {
    id: 'toggle-off-ignores-factor',
    input: { sourceWidth: 600, sourceHeight: 400, boxWidth: 600, displayFactor: 0.25, downscale: false, pixelRatio: 2 },
    expect: { result: null },
  },
];
