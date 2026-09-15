# SVG Smash

A Figma plugin that exports the current selection as SVG with every embedded PNG/JPEG re-encoded
as WebP. Figma's own SVG export embeds bitmaps as uncompressed base64 PNG — a 595×842 certificate
with five image fills comes out at 3.9 MB. The geometry is untouched: only the `data:` URI inside
each `(xlink:)href` attribute is replaced.

## Install

```
npm install
npm run build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`
from this repo. The plugin appears under Plugins → Development → SVG Smash.

Re-run `npm run build` after any source change, or `npm run watch` to rebuild on save. Figma
reloads `dist/` when you re-run the plugin.

## Use

1. Select one or more frames or components on the canvas.
2. Set **Quality** (1–100, default 85). Lower means smaller and softer.
3. Optionally turn on **Downscale to displayed size ×2** to re-sample oversized bitmaps.
4. Leave **Include "id" attribute** on and **Outline text** off unless you need otherwise.
5. Press **Export as WebP SVG**.

These last two mirror Figma's own SVG export panel and are passed straight to `exportAsync`:

- **Include "id" attribute** (on by default). Figma's own default is off, and with ids off its
  exporter drops `<g>` wrappers whose only attribute is `style="mix-blend-mode:…"` — a gradient
  meant to tint an image then paints flat over it. Turning ids on keeps those groups, at the cost
  of a layer-name id on every element.
- **Outline text** (off by default). Off keeps live `<text>` elements and their font names, which
  stays editable and searchable but needs the font installed wherever the file is opened. Turn it
  on to convert text to paths, which renders identically everywhere.

One `.svg` file is downloaded per selected node, named after the layer. The results list shows
before/after bytes per image and per file; every file also carries a "Save again" link that
re-downloads it.

## Limits

- Figma desktop may show one Save dialog per file. Exporting eight nodes means eight dialogs.
- Safari (Figma in the browser on macOS) has no WebP encoder. Every image is kept as is and the
  panel says so; the SVG is still offered.
- GIF, WebP, AVIF and SVG payloads are skipped — re-encoding them would either gain nothing or
  silently collapse an animation to one frame.
- An image is only replaced when WebP comes out smaller. Otherwise the original bytes survive
  byte-for-byte.

## Privacy

The plugin never writes to the document: no node properties, no plugin data, no new layers. It has
no network access — `manifest.json` declares `"networkAccess": { "allowedDomains": ["none"] }`.
Nothing is written to disk except the file you download.

## Develop

| Command | What it does |
|---|---|
| `npm run build` | bundles `dist/code.js`, `dist/transform.bundle.js`, `dist/ui.main.js`, composes `dist/ui.html` |
| `npm run watch` | the same on every change under `src/` |
| `npm run typecheck` | `tsconfig.code.json` (sandbox) and `tsconfig.ui.json` (iframe) |
| `npm test` | build, then the Playwright suite |
| `npm run check` | typecheck and test |

`npm test` exit codes:

- `0` — every assertion passed.
- `1` — one or more assertions failed. Artifacts land in `test/out/`.
- `2` — harness failure: `dist/` missing, browser launch failed, page crash.
- `3` — the transform bundle inlined in `dist/ui.html` is not the one on disk. Re-run `npm run build`.

The suite drives the shipped bundle, not a parallel copy: it loads `dist/transform.bundle.js` into
Chromium and asserts first that the same bytes are inlined in `dist/ui.html`.
