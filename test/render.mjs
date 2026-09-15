// test/render.mjs — deterministic screenshots (§7.6).
//
// SVG <image> elements are not in document.images and have no `complete` flag, so both SVGs
// go through an <img> wrapper, which has a real completion signal, at the SVG's intrinsic size.
//
// The document is rebuilt in place instead of through page.setContent: setContent navigates,
// and a navigation destroys `window.__out` (the output SVG that §7.5 deliberately keeps inside
// the page) together with `window.SvgSmash`. Everything else follows §7.6 — the viewport is
// set before the content, and both SVGs travel the identical path so any wrapper effect cancels.

const PAGE_STYLE = 'html,body{margin:0;padding:0;background:transparent}img{display:block}';

/** Runs in the page. `svg === null` means "render window.__out". Returns a decode error or null. */
const showSvg = async ({ svg, style }) => {
  const source = svg === null ? window.__out : svg;
  if (typeof source !== 'string') return 'no SVG to render';
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const css = document.createElement('style');
  css.textContent = style;
  document.head.replaceChildren(css);
  const img = document.createElement('img');
  img.id = 's';
  img.src = 'data:image/svg+xml;base64,' + btoa(binary);
  document.body.replaceChildren(img);
  try {
    await img.decode();
    return null;
  } catch (error) {
    return String(error);
  }
};

/** Clears the rendered document and the previous case's output SVG. */
export async function resetPage(page) {
  await page.evaluate(() => {
    window.__out = null;
    document.body.replaceChildren();
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string|null} svg  the SVG source, or null to render the page's own `window.__out`
 * @param {{width:number,height:number}} size  viewport and clip — the SVG's intrinsic size
 */
export async function renderShot(page, svg, size) {
  await page.setViewportSize(size); // MUST precede the content
  const decodeError = await page.evaluate(showSvg, { svg, style: PAGE_STYLE });
  const buf = await page.screenshot({
    omitBackground: true,
    type: 'png',
    animations: 'disabled',
    clip: { x: 0, y: 0, width: size.width, height: size.height },
  });
  return { buf, decodeError };
}
