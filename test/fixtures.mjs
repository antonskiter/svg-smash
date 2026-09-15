// test/fixtures.mjs — in-page fixture generation (§7.3).
// Node 24 has no image codec, so every bitmap is drawn inside Chromium and read back
// as a data URI. All pixel data comes from mulberry32(SEED); nothing calls Math.random.

export const SEED = 0x5eed;
// Pinned block size for `noise-blocks`. Measured, Chromium 149, mulberry32(0x5EED),
// PNG source vs WebP q85 re-encode, 4000x3000:
//   block  4: 3438767 -> 2636182 (x0.77)   block  6: 1743590 -> 3812902 (x2.19)
//   block  8: 1110535 ->  533786 (x0.48)   block 10:  825006 -> 2114282 (x2.56)
//   block 12:  653522 -> 1058032 (x1.62)   block 16:  480744 ->  395238 (x0.82)
//   block 20:  398039 ->  573448 (x1.44)   block 32:  302640 ->  189678 (x0.63)
// Compressibility is not monotonic in the block size: only blocks that align with WebP's
// macroblock grid (4, 8, 16, 32) compress at all — a misaligned block puts a hard colour
// edge inside every macroblock, and WebP spends more on the edge than PNG does. At every
// non-aligned size the keep rule keeps the PNG and `huge`, `figma-like` and `downscale-on`
// become unsatisfiable against a correct implementation.
// 16 is the size DESIGN.md §7.3's own cited figures describe (481 KB PNG vs 395 KB WebP,
// an 18% reduction) — the "20x20" literal there does not reproduce them; 16x16 does, exactly.
// Still block noise, not per-pixel noise: 4000x3000 stays at 481 KB, not 41 MB.
export const NOISE_BLOCK = 16;

// The `data-name` Figma writes next to the id of the first `figma-like` <image>. Exported so the
// case table asserts the same literal the fixture embeds.
export const FIGMA_LIKE_IMAGE_NAME = 'seal (1).png';

// 2x2 GIF89a: 6-byte signature, 2x2 logical screen, 2-entry global colour table,
// hand-packed LZW for the pixels [0,1,1,0] (round-trip verified against a decoder).
export const GIF_2PX_BASE64 = 'R0lGODlhAgACAIAAAAAAAP///ywAAAAAAgACAAACA0QCBQA7';

// 2x2 AVIF: ftyp(avif) + meta(hdlr,pitm,iloc,iinf/infe av01,iprp/ipco[ispe 2x2,pixi,av1C],ipma)
// + mdat. Box sizes and the iloc extent were generated and re-parsed. The coded payload is a
// placeholder: image/avif is not in RECODABLE, so the transform never reads a byte of it.
export const AVIF_2PX_BASE64 =
  'AAAAHGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZgAAANJtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAA' +
  'AAAAAAAAAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAPYAAAAIAAAAI2lpbmYAAAAAAAEA' +
  'AAAVaW5mZQIAAAAAAQAAYXYwMQAAAABWaXBycAAAADhpcGNvAAAAFGlzcGUAAAAAAAAAAgAAAAIAAAAQcGl4aQAA' +
  'AAADCAgIAAAADGF2MUOBAAAAAAAAFmlwbWEAAAAAAAAAAQABAwECgwAAABBtZGF0EgAyBBAQEBA=';

// A nested SVG document, base64 of:
// <svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#0f0"/></svg>
export const SVG_DOC_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyIiBoZWlnaHQ9IjIiPjxyZWN0' +
  'IHdpZHRoPSIyIiBoZWlnaHQ9IjIiIGZpbGw9IiMwZjAiLz48L3N2Zz4=';

export const IMAGES = [
  { id: 'alpha-png', w: 160, h: 160, mime: 'image/png', draw: 'quadrants-alpha' },
  { id: 'nonsquare-jpeg', w: 320, h: 120, mime: 'image/jpeg', draw: 'gradient' },
  { id: 'photo-png', w: 600, h: 400, mime: 'image/png', draw: 'noise-blocks' },
  { id: 'huge-png', w: 4000, h: 3000, mime: 'image/png', draw: 'noise-blocks' },
  { id: 'tiny-flat-png', w: 8, h: 8, mime: 'image/png', draw: 'solid' },
  { id: 'skip-webp', w: 64, h: 64, mime: 'image/webp', draw: 'solid' },
  { id: 'skip-gif', w: 2, h: 2, mime: 'image/gif', raw: GIF_2PX_BASE64 },
  { id: 'skip-avif', w: 2, h: 2, mime: 'image/avif', raw: AVIF_2PX_BASE64 },
  { id: 'skip-svg', w: 2, h: 2, mime: 'image/svg+xml', raw: SVG_DOC_BASE64 },
];

/** Runs in the page. Returns { id: { mime, base64, width, height } }. */
const drawAll = async ({ images, seed, block }) => {
  const mulberry32 = (a) => () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const DRAW = {
    // opaque red, 50% alpha blue, a clearRect hole, opaque green
    'quadrants-alpha': (ctx, w, h) => {
      const hw = w / 2;
      const hh = h / 2;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, hw, hh);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(hw, 0, hw, hh);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, hh, hw, hh);
      ctx.clearRect(0, hh, hw, hh);
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(hw, hh, hw, hh);
    },
    gradient: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#ff7a00');
      g.addColorStop(0.5, '#ffffff');
      g.addColorStop(1, '#0057ff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
    'noise-blocks': (ctx, w, h, rand, blockSize) => {
      for (let y = 0; y < h; y += blockSize) {
        for (let x = 0; x < w; x += blockSize) {
          const r = Math.floor(rand() * 256);
          const g = Math.floor(rand() * 256);
          const b = Math.floor(rand() * 256);
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          ctx.fillRect(x, y, blockSize, blockSize);
        }
      }
    },
    solid: (ctx, w, h) => {
      ctx.fillStyle = '#3b7dd8';
      ctx.fillRect(0, 0, w, h);
    },
  };

  const out = {};
  for (const im of images) {
    if (im.raw) {
      out[im.id] = { mime: im.mime, base64: im.raw, width: im.w, height: im.h };
      continue;
    }
    const canvas = document.createElement('canvas');
    canvas.width = im.w;
    canvas.height = im.h;
    const ctx = canvas.getContext('2d', { alpha: true });
    DRAW[im.draw](ctx, im.w, im.h, mulberry32(seed), block);
    const url = canvas.toDataURL(im.mime, 0.92);
    canvas.width = canvas.height = 1;
    out[im.id] = {
      mime: url.slice('data:'.length, url.indexOf(';')),
      base64: url.slice(url.indexOf(',') + 1),
      width: im.w,
      height: im.h,
    };
  }
  return out;
};

/** Draws every fixture in the page and verifies the browser produced the mime we asked for. */
export async function generatePayloads(page) {
  const payloads = await page.evaluate(drawAll, { images: IMAGES, seed: SEED, block: NOISE_BLOCK });
  for (const im of IMAGES) {
    const p = payloads[im.id];
    if (!p) throw new Error(`fixture ${im.id}: not generated`);
    if (p.mime !== im.mime) throw new Error(`fixture ${im.id}: browser produced ${p.mime}, wanted ${im.mime}`);
    if (!p.base64) throw new Error(`fixture ${im.id}: empty payload`);
  }
  return payloads;
}

export const dataUri = (p) => `data:${p.mime};base64,${p.base64}`;

/** 1/side rounded to 10 decimals, exactly as Figma writes it — 1/600 becomes the
 *  `scale(0.0016666667)` §7.3 pins, which is *above* 1/600 and puts the pattern-chain
 *  candidate at 300.000006. Rounding down instead would hide that: §4.5's ceil tolerance
 *  is what turns it back into 300, and this literal is the input that exercises it. */
const scaleOf = (side) => String(Math.round(1e10 / side) / 1e10);

const imageEl = ({ id, name, p, attr = 'xlink:href', quote = '"', uri, box, pos }) =>
  '<image' +
  (id ? ` id="${id}"` : '') +
  (name ? ` data-name="${name}"` : '') +
  (pos ? ` x="${pos.x}" y="${pos.y}"` : '') +
  ` width="${box.w}" height="${box.h}"` +
  (box.transform ? ` transform="${box.transform}"` : '') +
  ` ${attr}=${quote}${uri ?? dataUri(p)}${quote}/>`;

/** Figma's real layout: one element per line, flush left, <g clip-path> -> <rect fill="url(#pattern)">,
 *  <defs> with patterns and clipPaths, <image> last and self-closing. `names` is index-aligned
 *  with `images`: a name becomes the `data-name` Figma emits next to the id. */
function figmaDoc({ width, height, images, layers, names = [], attr = 'xlink:href', quote = '"' }) {
  const lines = [
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" ` +
      'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<g clip-path="url(#clip0_1_1)">',
  ];
  layers.forEach((l, i) =>
    lines.push(
      `<rect width="${l.w}" height="${l.h}" transform="translate(${l.x} ${l.y})" fill="url(#pattern${i}_1_1)"/>`,
    ),
  );
  lines.push('</g>', '<defs>');
  layers.forEach((l, i) => {
    lines.push(`<pattern id="pattern${i}_1_1" patternContentUnits="objectBoundingBox" width="1" height="1">`);
    lines.push(`<use xlink:href="#image${l.image}_1_1" transform="scale(${scaleOf(images[l.image].width)})"/>`);
    lines.push('</pattern>');
  });
  lines.push('<clipPath id="clip0_1_1">');
  lines.push(`<rect width="${width}" height="${height}" fill="white"/>`);
  lines.push('</clipPath>');
  const imageEls = images.map((p, i) =>
    imageEl({ id: `image${i}_1_1`, name: names[i], p, attr, quote, box: { w: p.width, h: p.height } }),
  );
  for (const el of imageEls) lines.push(el);
  lines.push('</defs>', '</svg>');
  return {
    svg: lines.join('\n') + '\n',
    width,
    height,
    verbatim: {
      // geometry that a value substitution must leave byte-identical
      uses: layers.map(
        (l) => `<use xlink:href="#image${l.image}_1_1" transform="scale(${scaleOf(images[l.image].width)})"/>`,
      ),
      // `<image>` head up to the data URI's mime, sliced off the element the document carries:
      // proves id, data-name and width/height survived the splice
      imageHeads: imageEls.map((el) => el.slice(0, el.indexOf('data:') + 'data:'.length)),
    },
  };
}

/** Post-processed shape: <image> drawn directly. Used by the cases about attribute
 *  spelling, quote style and failure paths, where a pattern chain adds nothing. */
function directDoc({ width, height, rows, xlink = false }) {
  const lines = [
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" ` +
      'xmlns="http://www.w3.org/2000/svg"' +
      (xlink ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '') +
      '>',
  ];
  for (const row of rows) lines.push(row.map((it) => imageEl(it)).join(''));
  lines.push('</svg>');
  return { svg: lines.join('\n') + '\n', width, height };
}

/** The truncated payload for `malformed`: a prefix whose length % 4 === 1, which atob rejects. */
function truncateToBadLength(base64) {
  let n = Math.min(101, base64.length);
  while (n % 4 !== 1) n -= 1;
  return base64.slice(0, n);
}

/** Every case SVG, keyed by case id: { svg, width, height, verbatim? }. */
export function buildSvgs(p) {
  const svgs = {};

  // §7.3 geometry: photo-png is referenced by two patterns whose rects are 150x100 and 90x60;
  // display factors 0.25 and 0.15 -> pattern-chain candidate ceil(600 x 0.25 x 2) = 300.
  // alpha-png's rect is 40x40 -> ceil(160 x 0.25 x 2) = 80. Both are below
  // sourceWidth x MIN_DOWNSCALE_GAIN and above MIN_TARGET_SIDE.
  const figmaLike = figmaDoc({
    width: 400,
    height: 300,
    images: [p['photo-png'], p['alpha-png'], p['skip-webp']],
    // only the first image carries a data-name, so the case asserts both the read and the fallback
    names: [FIGMA_LIKE_IMAGE_NAME],
    layers: [
      { image: 0, x: 10, y: 10, w: 150, h: 100 },
      { image: 0, x: 200, y: 10, w: 90, h: 60 },
      { image: 1, x: 10, y: 150, w: 40, h: 40 },
      { image: 2, x: 200, y: 150, w: 64, h: 64 },
    ],
  });
  svgs['figma-like'] = figmaLike;
  svgs['downscale-on'] = figmaLike;
  svgs['stub-bigger'] = figmaLike;
  svgs['stub-null'] = figmaLike;

  svgs['dup-payload'] = figmaDoc({
    width: 200,
    height: 100,
    images: [p['alpha-png'], p['alpha-png']],
    layers: [
      { image: 0, x: 10, y: 10, w: 80, h: 80 },
      { image: 1, x: 110, y: 10, w: 80, h: 80 },
    ],
  });

  svgs['dup-resolutions'] = figmaDoc({
    width: 400,
    height: 300,
    images: [p['photo-png'], p['photo-png']],
    layers: [
      { image: 0, x: 10, y: 10, w: 150, h: 100 },
      { image: 1, x: 200, y: 10, w: 90, h: 60 },
    ],
  });

  svgs['bare-href'] = directDoc({
    width: 160,
    height: 160,
    rows: [[{ p: p['alpha-png'], attr: 'href', quote: '"', pos: { x: 0, y: 0 }, box: { w: 160, h: 160 } }]],
  });

  svgs['single-quote'] = directDoc({
    width: 160,
    height: 160,
    rows: [[{ p: p['alpha-png'], attr: 'href', quote: "'", pos: { x: 0, y: 0 }, box: { w: 160, h: 160 } }]],
  });

  svgs['two-per-line'] = directDoc({
    width: 480,
    height: 160,
    xlink: true,
    rows: [
      [
        { p: p['alpha-png'], attr: 'href', quote: '"', pos: { x: 0, y: 0 }, box: { w: 160, h: 160 } },
        { p: p['nonsquare-jpeg'], attr: 'xlink:href', quote: '"', pos: { x: 160, y: 20 }, box: { w: 320, h: 120 } },
      ],
    ],
  });

  // <image> inside <pattern> inside <defs> inside <defs>.
  const nestedSide = p['alpha-png'].width;
  svgs['nested-defs'] = {
    width: 200,
    height: 200,
    svg:
      [
        '<svg width="200" height="200" viewBox="0 0 200 200" fill="none" ' +
          'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
        '<rect width="160" height="160" transform="translate(20 20)" fill="url(#pattern0_1_1)"/>',
        '<defs>',
        '<defs>',
        '<pattern id="pattern0_1_1" patternContentUnits="objectBoundingBox" width="1" height="1">',
        imageEl({
          id: 'image0_1_1',
          p: p['alpha-png'],
          box: { w: nestedSide, h: nestedSide, transform: `scale(${scaleOf(nestedSide)})` },
        }),
        '</pattern>',
        '</defs>',
        '</defs>',
        '</svg>',
      ].join('\n') + '\n',
  };

  // 320x120 jpeg, rect 80x30 -> factor 0.25 -> candidate 160x60, the source aspect exactly.
  svgs.nonsquare = figmaDoc({
    width: 120,
    height: 60,
    images: [p['nonsquare-jpeg']],
    layers: [{ image: 0, x: 10, y: 10, w: 80, h: 30 }],
  });

  svgs.huge = figmaDoc({
    width: p['huge-png'].width,
    height: p['huge-png'].height,
    images: [p['huge-png']],
    layers: [{ image: 0, x: 0, y: 0, w: p['huge-png'].width, h: p['huge-png'].height }],
  });

  svgs.lossless = figmaDoc({
    width: p['alpha-png'].width,
    height: p['alpha-png'].height,
    images: [p['alpha-png']],
    layers: [{ image: 0, x: 0, y: 0, w: p['alpha-png'].width, h: p['alpha-png'].height }],
  });

  const keptHrefValue = dataUri(p['tiny-flat-png']);
  svgs['keep-original'] = {
    ...directDoc({
      width: 32,
      height: 32,
      rows: [[{ p: p['tiny-flat-png'], attr: 'href', quote: '"', pos: { x: 0, y: 0 }, box: { w: 8, h: 8 } }]],
    }),
    verbatim: { kept: `href="${keptHrefValue}"` },
  };

  svgs['skip-only'] = directDoc({
    width: 96,
    height: 32,
    rows: [
      [{ p: p['skip-webp'], attr: 'href', quote: '"', pos: { x: 0, y: 0 }, box: { w: 64, h: 64 } }],
      [{ p: p['skip-gif'], attr: 'href', quote: '"', pos: { x: 64, y: 0 }, box: { w: 2, h: 2 } }],
      [{ p: p['skip-avif'], attr: 'href', quote: '"', pos: { x: 64, y: 8 }, box: { w: 2, h: 2 } }],
      [{ p: p['skip-svg'], attr: 'href', quote: '"', pos: { x: 64, y: 16 }, box: { w: 2, h: 2 } }],
    ],
  });

  svgs['no-images'] = {
    width: 200,
    height: 120,
    svg:
      [
        '<svg width="200" height="120" viewBox="0 0 200 120" fill="none" xmlns="http://www.w3.org/2000/svg">',
        '<path d="M10 10L190 10L100 110Z" fill="url(#paint0_linear_1_1)"/>',
        '<path d="M20 100C60 20 140 20 180 100" stroke="#123456" stroke-width="4"/>',
        '<defs>',
        '<linearGradient id="paint0_linear_1_1" x1="10" y1="10" x2="190" y2="110" gradientUnits="userSpaceOnUse">',
        '<stop stop-color="#FF7A00"/>',
        '<stop offset="1" stop-color="#0057FF"/>',
        '</linearGradient>',
        '</defs>',
        '</svg>',
      ].join('\n') + '\n',
  };

  const truncated = truncateToBadLength(p['alpha-png'].base64);
  const externalTag = (uri) =>
    imageEl({ uri, attr: 'href', quote: '"', pos: { x: 170, y: 60 }, box: { w: 8, h: 8 } });
  const malformedUris = {
    truncated: `data:image/png;base64,${truncated}`,
    empty: 'data:image/png;base64,',
    gifAsPng: `data:image/png;base64,${GIF_2PX_BASE64}`,
    external: 'https://example.invalid/pic.png',
  };
  svgs.malformed = {
    ...directDoc({
      width: 200,
      height: 160,
      rows: [
        [{ p: p['alpha-png'], attr: 'href', quote: '"', pos: { x: 0, y: 0 }, box: { w: 160, h: 160 } }],
        [{ uri: malformedUris.truncated, attr: 'href', quote: '"', pos: { x: 170, y: 0 }, box: { w: 8, h: 8 } }],
        [{ uri: malformedUris.empty, attr: 'href', quote: '"', pos: { x: 170, y: 20 }, box: { w: 8, h: 8 } }],
        [{ uri: malformedUris.gifAsPng, attr: 'href', quote: '"', pos: { x: 170, y: 40 }, box: { w: 2, h: 2 } }],
        [{ uri: malformedUris.external, attr: 'href', quote: '"', pos: { x: 170, y: 60 }, box: { w: 8, h: 8 } }],
      ],
    }),
    verbatim: {
      truncated: `href="${malformedUris.truncated}"`,
      empty: `href="${malformedUris.empty}"`,
      gifAsPng: `href="${malformedUris.gifAsPng}"`,
      external: `href="${malformedUris.external}"`,
      // what the external <image> would read if the transform had rewritten it
      externalRewritten: (() => {
        const tag = externalTag(malformedUris.external);
        return tag.slice(0, tag.indexOf(malformedUris.external)) + 'data:';
      })(),
    },
  };

  return svgs;
}

/** Coordinates that quadrants-alpha leaves fully transparent, in the rendered frame of a case.
 *  Only declared where the budget demands exact alpha (§7.6 item 2). */
export const ALPHA_PROBES = {
  lossless: [{ x: 40, y: 120 }],
};
