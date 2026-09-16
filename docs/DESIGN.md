# SVG Smash — authoritative technical design

This file plus the project spec are the only inputs implementers need.

Three invariants govern everything below.

1. **The transform is a substitution of attribute *values*.** It replaces the `data:…` URI inside `(xlink:)href="…"` and nothing else. `<image width/height>`, `preserveAspectRatio`, `<use transform>`, patterns, defs, ids, quote style, whitespace — all stay byte-identical. A smaller bitmap in the same `<image>` box changes resolution, not layout, so geometry can never drift.
2. **Every failure path keeps the original bytes and records a reason.** Nothing throws past the per-image boundary. One bad image never costs a good one, and never aborts an export.
3. **The test drives the shipped artifact.** `dist/transform.bundle.js` is built once, inlined verbatim into `dist/ui.html`, and loaded by Playwright. The test asserts that identity before asserting anything else.

---

## 0. Step 0 — contract files before parallel work

**shell** writes these two files first, verbatim from §3 and §4, and does not change them afterwards without telling ui and test:

- `src/protocol.ts` (§3) — owner shell, permanently.
- `src/ui/types.ts` (§4.1) — **ui** owns it after step 0; shell only creates the initial copy so `code.ts` and the test can be written immediately.

The repo starts clean: only `.gitignore` and `docs/DESIGN.md` exist. `package.json` is written at step 0 verbatim from §2.5.

---

## 1. File layout and ownership

One owner per file. No file is edited by two people. A needed change in someone else's file is a request to that owner. *Importing* another owner's module is unrestricted — only editing is owned. `test/run.mjs` imports `scripts/htmlregion.mjs`; that is the intended arrangement, not a boundary violation.

| Path | Owner | Contents |
|---|---|---|
| `package.json` | shell | scripts + exact devDeps (§2.5) |
| `package-lock.json` | shell | generated |
| `.gitignore` | shell | keep as is; add `dist/build.json` is **not** wanted (it is inside `dist/`) |
| `manifest.json` | shell | Figma manifest (§2.6) |
| `README.md` | shell | install, build, usage, limits (§9) |
| `tsconfig.code.json` | shell | sandbox project |
| `tsconfig.ui.json` | ui | UI project |
| `scripts/build.mjs` | shell | esbuild driver + HTML composition + watch |
| `scripts/htmlregion.mjs` | shell | `TRANSFORM_BEGIN`/`TRANSFORM_END` + `extractTransformRegion`; imported by `build.mjs` **and** `test/run.mjs` |
| `src/protocol.ts` | shell | message types, frozen at step 0 |
| `src/code.ts` | shell | sandbox entry |
| `src/ui/types.ts` | ui | transform API types |
| `src/ui/transform.ts` | ui | **bundle entry**: barrel + `transformSvg` orchestrator |
| `src/ui/scan.ts` | ui | regexes, hit scan, enclosing-tag/attr parsing (pure) |
| `src/ui/imagesize.ts` | ui | PNG/JPEG/WebP/GIF header sniffing (pure) |
| `src/ui/sizing.ts` | ui | target-size resolver + pattern-chain display factors (pure) |
| `src/ui/base64.ts` | ui | base64 length + decode (pure) |
| `src/ui/splice.ts` | ui | apply non-overlapping edits (pure) |
| `src/ui/encode-canvas.ts` | ui | the only file that touches canvas/DOM decode+encode |
| `src/ui/main.ts` | ui | UI app: state machine, messaging, rendering |
| `src/ui/format.ts` | ui | byte/percent formatting (pure) |
| `src/ui/download.ts` | ui | filename sanitising + blob download sequencing; its two pure functions are re-exported by `transform.ts` (§4.2) so the bundle carries them |
| `src/ui/ui.template.html` | ui | markup, inline CSS, injection sentinels |
| `test/run.mjs` | test | runner, exit codes, artifacts |
| `test/cases.mjs` | test | case table (data only) |
| `test/fixtures.mjs` | test | in-page fixture generation |
| `test/render.mjs` | test | deterministic screenshot helper |
| `test/assert.mjs` | test | pixel diff, alpha, size assertions |

Generated, nobody edits: `dist/code.js`, `dist/transform.bundle.js`, `dist/ui.main.js`, `dist/ui.html`, `dist/build.json`, `test/out/**`.

The ownership boundary is typechecked, not conventional: `tsconfig.code.json` has `"lib": ["es2020"]` only, so `document` in `code.ts` fails to compile; `tsconfig.ui.json` has `"types": []` and no `@figma` type root, so `figma.*` in UI code fails to compile.

---

## 2. Build

### 2.1 Targets

`scripts/build.mjs`, esbuild JS API, table-driven:

```js
const COMMON = { bundle: true, target: 'es2020', format: 'iife', platform: 'browser',
                 charset: 'utf8', legalComments: 'none', logLevel: 'warning' };

const TARGETS = [
  { id: 'code',      entry: 'src/code.ts',         outfile: 'dist/code.js' },
  { id: 'transform', entry: 'src/ui/transform.ts', outfile: 'dist/transform.bundle.js',
    globalName: 'SvgSmash' },
  { id: 'uimain',    entry: 'src/ui/main.ts',      outfile: 'dist/ui.main.js' },
];
```

`minify` is off. A local dev plugin gains nothing from it and loses readable stack traces; the only size that matters is the exported SVG. `sourcemap: 'inline'` on the transform bundle only — written as a field on that row rather than applied outside the table, so `globalName` and `sourcemap` are both per-target data and `buildTarget` needs no branch for either.

### 2.2 One transform bundle, two consumers

`src/ui/main.ts` must **not** `import` the transform — esbuild would inline a second copy and the identity claim in §7.2 would be false. It declares the global the IIFE installs:

```ts
// src/ui/main.ts
declare const SvgSmash: typeof import('./transform');
```

Types-only: `tsc` checks every call, esbuild emits no import.

### 2.3 HTML composition

`src/ui/ui.template.html` carries two sentinels, each on its own line:

```html
<!--@TRANSFORM@-->
<!--@UI@-->
```

The sentinels and the extractor live in **one** file, `scripts/htmlregion.mjs`, because the build writes the region and the test re-reads it; two copies of the trimming rule is how a healthy build gets reported stale (exit 3).

```js
// scripts/htmlregion.mjs — the single source of the region contract
export const TRANSFORM_BEGIN = '/*@svg-smash:transform:begin@*/';
export const TRANSFORM_END   = '/*@svg-smash:transform:end@*/';

/** The text between the sentinels with exactly one leading and one trailing '\n' removed.
 *  Returns null when either sentinel is absent. */
export function extractTransformRegion(html) {
  const a = html.indexOf(TRANSFORM_BEGIN);
  const b = html.indexOf(TRANSFORM_END);
  if (a < 0 || b < 0 || b < a) return null;
  let s = html.slice(a + TRANSFORM_BEGIN.length, b);
  if (s.startsWith('\n')) s = s.slice(1);
  if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}
```

Composition, in `build.mjs`, which imports both sentinels and `extractTransformRegion` from that file:

```js
import { TRANSFORM_BEGIN, TRANSFORM_END, extractTransformRegion } from './htmlregion.mjs';

const transformTag = '<script>' + TRANSFORM_BEGIN + '\n' + transformJs + '\n' + TRANSFORM_END + '</' + 'script>';
const uiTag        = '<script>' + uiMainJs + '</' + 'script>';
```

Two build-time guards, both hard throws:

1. `transformJs` or `uiMainJs` containing `</script` or `<!--` → throw. Either would truncate `dist/ui.html` silently.
2. `extractTransformRegion(html)` must `=== transformJs`.
3. `src/ui/ui.template.html` missing either sentinel → throw, by name. Guard 2 only covers the transform side, so without this a missing `<!--@UI@-->` would ship a `dist/ui.html` with no UI script and no complaint.

Then write `dist/ui.html` and `dist/build.json`:

```json
{ "transformSha256": "<hex of dist/transform.bundle.js>", "builtAt": "<iso>" }
```

`dist/` is created with `fs.mkdir(…, { recursive: true })` — Bash `mkdir` is hook-blocked, Node's is not. No shell redirects anywhere.

### 2.4 Watch

`node scripts/build.mjs --watch`: `fs.watch('src', { recursive: true })` with a 50 ms debounce → full `buildAll()`. A cold build of three small bundles is ~20 ms; incremental contexts buy nothing and add a race with HTML composition.

### 2.5 package.json (verbatim)

```json
{
  "name": "svg-smash",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "watch": "node scripts/build.mjs --watch",
    "typecheck": "tsc -p tsconfig.code.json && tsc -p tsconfig.ui.json",
    "test": "npm run build && node test/run.mjs",
    "test:only": "node test/run.mjs",
    "check": "npm run typecheck && npm run test"
  },
  "devDependencies": {
    "@figma/plugin-typings": "1.138.0",
    "esbuild": "0.28.2",
    "typescript": "5.9.3",
    "playwright": "1.61.1",
    "pixelmatch": "7.2.0",
    "pngjs": "7.0.0"
  }
}
```

Every version is exact, and every pin has one reason:

- `playwright` **1.61.1** — the only released line whose `browsers.json` points at chromium revision **1228**, which is what is cached at `~/Library/Caches/ms-playwright`. `^` resolves to 1.63.0 → rev 1243 → a browser download on `npm ci`.
- `@figma/plugin-typings` **1.138.0** — ships roughly weekly and declares global types; a float silently changes what compiles.
- `typescript` **5.9.3** — not 7.0.2. The 7.x line is the new native compiler; nothing here needs it and its flag surface is unproven for this repo.
- `esbuild` **0.28.2**, `pixelmatch` **7.2.0**, `pngjs` **7.0.0** — versions the registry resolves today (checked 2026-09-15) and the ones the research measured against.

Both tsconfigs: `"strict": true`, `"noEmit": true`, `"target": "es2020"`, `"module": "esnext"`, `"moduleResolution": "bundler"`, `"noUncheckedIndexedAccess": true`. Differences:

- `tsconfig.code.json` — `"lib": ["es2020"]`, `"typeRoots": ["./node_modules/@types", "./node_modules/@figma"]`, `"include": ["src/code.ts", "src/protocol.ts"]`.
- `tsconfig.ui.json` — `"lib": ["es2020", "dom", "dom.iterable"]`, `"types": []`, `"include": ["src/ui/**/*.ts", "src/protocol.ts"]`.

Test files are `.mjs` and are not typechecked.

### 2.6 manifest.json (verbatim)

```json
{
  "name": "SVG Smash",
  "id": "1681717935402513762",
  "api": "1.0.0",
  "editorType": ["figma"],
  "main": "dist/code.js",
  "ui": "dist/ui.html",
  "documentAccess": "dynamic-page",
  "networkAccess": { "allowedDomains": ["none"] }
}
```

---

## 3. Message protocol

`src/protocol.ts`, verbatim. Discriminated on `type`, no `any`, structured-clone-safe (strings, numbers, booleans, plain objects, arrays only).

```ts
export interface SelectionItem {
  id: string;
  name: string;          // raw Figma node name, unsanitised
  type: string;          // node.type, e.g. 'FRAME'
  exportable: boolean;   // 'exportAsync' in node
}

export type ErrorCode = 'no-selection' | 'nothing-exportable' | 'export-failed';

export const ERROR_TEXT: Record<ErrorCode, string> = {
  'no-selection': 'Select at least one frame or component, then press Export.',
  'nothing-exportable': 'Nothing in the selection can be exported as SVG.',
  'export-failed': 'Figma could not export this node as SVG.',
};

/** The Figma export-panel switch the plugin mirrors. Structured-clone-safe booleans. */
export interface SvgExportSettings {
  svgOutlineText: boolean;
}

/** Figma's own default is the opposite; see §8 for why this one wins. */
export const DEFAULT_SVG_EXPORT: SvgExportSettings = { svgOutlineText: false };

/** Sandbox -> UI. Sent with figma.ui.postMessage(msg) — no wrapper. */
export type CodeToUi =
  | { type: 'selection'; items: SelectionItem[] }
  | { type: 'export-begin'; total: number }
  | { type: 'svg'; index: number; total: number; nodeId: string; nodeName: string; svg: string }
  | { type: 'export-end'; total: number; exported: number; failed: number }
  | { type: 'error'; code: ErrorCode; message: string; nodeId: string | null };

/** UI -> sandbox. Sent with parent.postMessage({ pluginMessage: msg }, '*'). */
export type UiToCode =
  | { type: 'ui-ready' }
  | { type: 'export-request'; settings: SvgExportSettings }
  | { type: 'ui-done'; files: number; originalBytes: number; newBytes: number; failed: number }
  | { type: 'ui-error'; message: string }
  | { type: 'close' };
```

Rules that follow from it:

- **Quality and downscale never cross the boundary; the SVG export switch must.** Quality and downscale drive the encoder, which runs in the iframe, so they live in the UI DOM and are read at export time by `readOptions()` — putting them on the wire would create a stale-echo desync for zero benefit. `svgOutlineText` drives `exportAsync`, which runs in the sandbox, so it is read the same way by `readExportSettings()` and travels as the `settings` payload of `export-request`. `svgIdAttribute` is not on the wire at all: it is hard-wired on in `exportSettings` (§3.1). Neither set is persisted; they reset to 85 / off / outline-off each run.
- **One `svg` message per node, whole string.** No chunking, no `Uint8Array`, no `TextDecoder`. There is no documented size cap (see risk 4); if one surfaces, chunking is a protocol-local change with no transform impact.
- **Handshake first.** `code.ts` sends nothing until `ui-ready` arrives. Pre-load message queueing is unverified and is not relied on.
- **Per-node errors.** A node that fails `exportAsync` produces `error` with `code: 'export-failed'` and the loop continues; `export-end` always arrives.
- **There is no progress message on the UI→sandbox channel.** Progress is rendered inside the iframe (§6 item 6) and has no second consumer, so nothing sends it and nothing would receive it.
- **`code.ts` always sets `message = ERROR_TEXT[code]`.** For a *received* `error` the UI renders `error.message` verbatim and never re-derives it from the code. The UI imports `ERROR_TEXT` only for its own `no-selection` state (§6 item 1), which no message precedes. Either way the text exists once, in `protocol.ts`.

### 3.1 `src/code.ts`

```ts
const UI_SIZE = { width: 400, height: 560, themeColors: true, title: 'SVG Smash' } as const;
// Ids are always on: with them off, exportAsync drops <g> wrappers that only carry a blend mode.
const exportSettings = (s: SvgExportSettings): ExportSettingsSVGString =>
  ({ format: 'SVG_STRING', svgIdAttribute: true, ...s });
const yieldToHost = () => new Promise<void>((r) => setTimeout(r, 0));

function describeSelection(): SelectionItem[];   // pure read of figma.currentPage.selection
function post(msg: CodeToUi): void;              // the only effect wrapper
async function runExport(settings: SvgExportSettings): Promise<void>;
```

Order: `figma.showUI(__html__, UI_SIZE)` synchronously at top level → wait for `ui-ready` → post `selection`. `figma.on('selectionchange', …)` re-posts `selection`.

`runExport`: filter the selection with `'exportAsync' in node`. The two empty outcomes are distinct and neither is a judgment call:

- `figma.currentPage.selection.length === 0` → `error { code: 'no-selection', message: ERROR_TEXT['no-selection'], nodeId: null }`.
- selection non-empty but the filter leaves nothing → `error { code: 'nothing-exportable', message: ERROR_TEXT['nothing-exportable'], nodeId: null }`.

Either way, then `export-end {total:0, exported:0, failed:0}`. Otherwise post `export-begin`, then per node in order: `await node.exportAsync(exportOptions)` in try/catch → `svg` or `error`, then `await yieldToHost()`. Finish with `export-end`. `exportOptions` is `exportSettings(msg.settings)`, built once per run before the loop, so every node in one export gets identical settings.

`ui-progress` does not exist; the sandbox receives only `ui-ready`, `export-request`, `ui-done`, `ui-error` and `close`, and an unknown `type` is ignored.

`svgIdAttribute` is **hard-wired on**, against Figma's own default, because the flag is not only about ids: with it off, `exportAsync` drops `<g>` wrappers whose only attribute is `style="mix-blend-mode:…"` (§8), which silently changes how the file paints. It is written in `exportSettings` rather than offered as a switch — the only thing ids cost is a layer-name id on every element, and no export is worth the paint bug. `svgOutlineText` defaults to **off**, again against Figma's default, so `<text>` and font names survive the round trip; it stays a user-visible switch (§6) because live text needs the font installed on the viewing machine.

`ui-done` → `figma.notify(...)` (≤100 chars) and the plugin stays open so the user can re-run at another quality. The string is composed here from the message's counts — `Exported 3 files — 89% smaller.` — deliberately without byte formatting: `formatBytes` lives in `src/ui/format.ts`, and importing it would pull a UI module into `dist/code.js` for one notification. `ui-error` → `figma.notify(msg, { error: true })`. `close` → `figma.closePlugin(); return;`.

The sandbox writes nothing to the document: no property assignment on nodes, no `setPluginData`, no new nodes.

---

## 4. Transform module

### 4.1 `src/ui/types.ts` (verbatim)

```ts
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
```

### 4.2 `src/ui/transform.ts` — public surface (verbatim)

```ts
export async function transformSvg(
  svg: string, options: TransformOptions, deps: Deps,
): Promise<TransformResult>;

export function createCanvasEncoder(): Encoder;                          // real DOM encoder
export function withCallCount(e: Encoder): Encoder & { calls: number };  // test instrumentation
export function createStubEncoder(kind: 'bigger' | 'null'): Encoder;     // test doubles, §7.4
export function scanImages(svg: string): ImageHit[];                     // exported for unit assertions

export { RECODABLE, recodable, DATA_IMAGE_HREF_SOURCE } from './scan';
export { CANVAS_LIMITS, MIN_TARGET_SIDE, MIN_DOWNSCALE_GAIN, ASPECT_TOLERANCE } from './types';
export { resolveTargetSize, resolveDisplayFactors } from './sizing';
export { base64ByteLength } from './base64';
export { sanitizeName, uniqueName } from './download';
export type * from './types';
```

Three rules this list encodes, each of which a plausible reading gets wrong:

- **Constants live where §4.1 puts them.** `CANVAS_LIMITS`, `MIN_TARGET_SIDE`, `MIN_DOWNSCALE_GAIN` and `ASPECT_TOLERANCE` are declared in `src/ui/types.ts` and re-exported from there. `scan.ts` declares only `RECODABLE`, `recodable` and `DATA_IMAGE_HREF_SOURCE`. A second declaration of any constant is a defect, not a convenience.
- **`export type *` erases runtime values.** Everything above the `export type *` line is a value export and must stay one, or the constant never reaches `window.SvgSmash`.
- **Everything the test asserts against must be on this surface.** The test is `.mjs` and cannot import `.ts`; the only way into `sanitizeName`, `uniqueName`, `base64ByteLength`, `resolveTargetSize` and the stub encoders is this bundle (§7.6). `download.ts` is therefore in the transform entry's import graph — it holds no DOM code at module scope, so bundling it costs nothing.

`createStubEncoder('bigger')` returns `{ ok: true, dataUrl: 'data:image/webp;base64,' + 'A'.repeat(n), bytes: input.bytes.length + 1024, width, height }` with `width`/`height` from `input.target` or the sniffed size; `createStubEncoder('null')` returns `{ ok: false, reason: 'encoder-returned-null' }`. Both are selected by name from the case table, so no function ever has to cross `page.evaluate`.

Two signatures above cannot carry a signal their caller needs, so each has a richer sibling inside its own module: `resolveTargetSize` returns `TargetSize | null` and cannot report `aspect-drift`, and `resolveDisplayFactors` returns a bare `Map` and cannot report `empty-pattern:<id>`. `sizing.ts` adds `resolveTarget` and `resolveDisplayFactorsDetailed`; the two names above are one-line wrappers over them and remain the public surface, so the bundle's exported API is exactly the 17 names listed here.

`transformSvg` touches no DOM API — every effect is behind `deps.encoder`. It rejects only if `svg` is not a string. Contract: for any input it returns a `TransformResult` whose `svg` is either the input or a valid replacement, within `images.length × perImageTimeoutMs` plus parse time.

### 4.3 Scanning — regexes verbatim

```ts
// src/ui/scan.ts

/** Source kept separate so each caller builds a fresh regex; a shared /g object carries lastIndex.
 *  Flags 'gd' — the `d` flag gives m.indices.groups.uri, so no offset arithmetic is needed. */
export const DATA_IMAGE_HREF_SOURCE =
  '(?<![-\\w])(?<attr>(?:xlink:)?href)\\s*=\\s*(?<q>["\'])' +
  '(?<uri>data:image\\/(?<subtype>[A-Za-z0-9.+-]+)(?:;[A-Za-z0-9.+=-]+)*?;base64,' +
  '(?<payload>[^"\'<>]*))\\k<q>';

export const makeHrefRe = (): RegExp => new RegExp(DATA_IMAGE_HREF_SOURCE, 'gd');
```

Every piece is load-bearing:

- `(?<![-\w])` and not `\b` — `\b` matches inside `data-href=`, the lookbehind does not. Lookbehind is supported in Chromium 149 and Node 24.
- `(?:xlink:)?href` — both spellings ship today; a file is internally consistent but which one is unpredictable, and a declared `xmlns:xlink` proves nothing.
- `(?<q>["'])…\k<q>` — both quote styles, matched pairwise. Only the `uri` group is spliced, so the original attribute name and quote character survive for free.
- `[^"'<>]*` for the payload — greedy negated class, never lazy. Base64 contains none of those characters, so the match is linear with no backtracking on a 4 MB payload, whitespace-wrapped base64 still matches, and an unterminated quote cannot swallow the rest of the document.
- Optional `(?:;[A-Za-z0-9.+=-]+)*?` before `;base64,` tolerates `;charset=…`.
- Subtype captured generically — png, jpeg, webp and gif all occur in real exports.
- No `/i` flag: SVG is XML and attribute names are case-sensitive. `HREF=` is not Figma output and is left alone.

Structure is irrelevant to the scan, which is the whole answer to "images inside `<pattern>`/`<defs>`": nesting depth and pattern indirection are invisible to a value substitution.

**Recodable set — a positive table, so unknown mimes default to the safe action:**

```ts
export const RECODABLE: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/jpg']);
export const recodable = (mime: string): boolean => RECODABLE.has(mime.toLowerCase());
```

Anything else → `action: 'skipped-unsupported'`, `reason: 'mime:' + mime`, bytes untouched. GIF is excluded deliberately: re-encoding would silently collapse an animation to frame 1.

**The spec's skip list is a consequence of this table, not a second list.** `image/webp`, `image/avif`, `image/gif` and `image/svg+xml` are all `!RECODABLE`, so all four are skipped by the same line of code that skips anything unknown. There is no negative list to keep in sync, and the four are covered by the `skip-only` case (§7.4) rather than by four branches.

**Magic bytes win over the declared mime.** `src/ui/imagesize.ts`:

```ts
export interface Sniffed { mime: string; width: number; height: number }
export const SNIFFERS: ReadonlyArray<(b: Uint8Array) => Sniffed | null> =
  [sniffPng, sniffJpeg, sniffWebp, sniffGif];
export function sniff(bytes: Uint8Array): Sniffed | null;  // first non-null wins
```

`sniffPng` checks the 8-byte signature and reads IHDR width/height at offsets 16 and 20. `sniffJpeg` walks SOI plus segment markers to the first SOF0/1/2/9/10 and reads height then width. `sniffWebp` and `sniffGif` exist to catch a mislabelled payload. Nothing sniffs → `failed`, `reason: 'unrecognized-bitmap'` — the malformed-data-URI case, caught before a pixel is allocated. Sniffed mime not recodable while the declared one was → `skipped-unsupported`, `reason: 'mime-mismatch:' + sniffed`.

**Enclosing tag** (`scan.ts`):

```ts
export const TAG_NAME_RE  = /^<\s*([A-Za-z_][\w.:-]*)/;                 // not global — safe as a constant
export const makeAttrRe    = (): RegExp => /([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^"']*)\2/g;
export const makeTagSizeRe = (): RegExp =>
  /(?:^|[\s"'\/])(width|height)\s*=\s*(["'])\s*(\+?\d*\.?\d+)\s*(?:px)?\s*\2/g;
```

**Every `/g` regex in this codebase is produced by a factory; no global regex object is ever shared between calls.** A `/g` `RegExp` carries `lastIndex` across `exec` loops, and every loop here can exit early — one abandoned pattern in node 1 would make node 2 of the same export start scanning from a stale offset. The bug is invisible in a single-node test and its symptom is silently lost downscale factors, not an error. Only non-global regexes (`TAG_NAME_RE`, `SVG_ROOT_RE`, `ROOT_WIDTH_RE`, `ROOT_VIEWBOX_RE`, `ANCESTOR_SCALE_RE`, `TRANSFORM_ATTR_RE`) may be module-level constants.

1. `start = svg.lastIndexOf('<', hit.uriStart)` — no attribute value before `href` in an SVG tag contains `<`.
2. `end = svg.indexOf('>', hit.uriEnd)` — searched from *past* the payload; base64 contains no `>`.
3. `tagText = svg.slice(start, end + 1)` **with the uri region cut out** before running `makeAttrRe()`. This keeps attribute parsing off the multi-megabyte payload: one pass over ~150 characters instead of three over 3 MB.
4. `TAG_NAME_RE` → `tagName`; `makeAttrRe()` → `Record<string,string>` for `id`; `makeTagSizeRe()` → `boxWidth`/`boxHeight`.

The size regex uses a leading character class instead of `\b` so `stroke-width` cannot match. `width="50%"` and `width="1e3"` do not match and yield `null` — an unknown size is always safer than a wrong one. A hit whose enclosing tag is not `image` still gets converted; only the size hints are `null`.

### 4.4 Base64 (`src/ui/base64.ts`, verbatim)

```ts
export const B64_CLEAN_RE = /[\s\r\n]+/g;
export const B64_VALID_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Character class AND length. `atob` throws InvalidCharacterError on length % 4 === 1
 *  ('A', 'AAAAA'), which the character class alone accepts — measured identically in
 *  Node 24 and Chromium 149. Without the length test a truncated payload escapes the
 *  closed reason set of §4.10 and reports `String(error)` instead of `bad-base64`. */
export const b64Valid = (clean: string): boolean =>
  B64_VALID_RE.test(clean) && clean.length % 4 !== 1;

/** Exact decoded length from cleaned base64, no allocation. */
export function base64ByteLength(clean: string): number {
  if (clean.length === 0) return 0;
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

export function base64ToBytes(clean: string): Uint8Array {
  const bin = atob(clean);                       // one binary string, no argument-list limit
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

Whitespace is stripped with `B64_CLEAN_RE` before any length or decode call, so a post-processed, line-wrapped SVG reports honest byte counts. A payload of length 0 → `failed`/`'empty-payload'`; a payload failing `b64Valid` → `failed`/`'bad-base64'`, whichever of the two tests rejected it. Both keep the original bytes. `base64ToBytes` is only ever called on a payload that passed `b64Valid`.

**There is no manual base64 on the output path.** `FileReader.readAsDataURL(blob)` returns the finished `data:image/webp;base64,…` string and `blob.size` gives `newBytes`. `String.fromCharCode.apply` is never called on a large array, because the problem is deleted rather than chunked around.

### 4.5 Downscale target (`src/ui/sizing.ts`)

The spec says to take the cap from the `<image>` element's `width`/`height`. Verified measurement says those attributes are the **intrinsic bitmap size**, not the displayed size (7 files, 10 images, exact match against decoded PNG IHDR / WebP VP8 headers). Taken literally, `min(intrinsic, 2 × attr)` is always `intrinsic` and the toggle is a dead control.

Resolution: an ordered candidate table. The spec's rule is implemented as written and kept as the always-available fallback; a pattern-chain candidate is evaluated ahead of it so the toggle does something; a limits candidate runs regardless of the toggle. The winner is the **smallest** candidate, and `sizeSource` records which one won — in the report, in the UI, and in an assertion.

```ts
export interface SizingInput {
  sourceWidth: number; sourceHeight: number;      // intrinsic, from the sniffer
  boxWidth: number | null;                        // <image width> attr
  displayFactor: number | null;                   // §4.6, null when unresolved
  downscale: boolean; pixelRatio: number;
  maxSide: number; maxPixels: number;
}

export function resolveTargetSize(
  i: SizingInput,
): { width: number; height: number; source: SizeSource } | null;   // null = keep intrinsic
```

There are two kinds of candidate and they obey different rules. **`limits` is a hard requirement; `pattern-chain` and `image-attrs` are optimisations.** Suppressing an optimisation costs a little quality; suppressing `limits` sends an over-limit bitmap into the encoder, where §4.7's guard returns `canvas-side-exceeded`/`canvas-area-exceeded` and the image is kept uncompressed — exactly the class of image the candidate was written for.

**The `limits` candidate — evaluated always, toggle or not, never suppressed:**

```ts
const s = Math.min(
  1,
  Math.sqrt(maxPixels / (sourceWidth * sourceHeight)),
  maxSide / sourceWidth,
  maxSide / sourceHeight,
);
const limitsWidth = s < 1 ? Math.max(1, Math.floor(sourceWidth * s)) : null;
```

Both axes are bounded, so a 1000×70000 or a 100000×10 source is brought under `maxSide` as well as under `maxPixels`. `s === 1` means the source already fits and there is no `limits` candidate at all. Neither `MIN_TARGET_SIDE`, nor `MIN_DOWNSCALE_GAIN`, nor `ASPECT_TOLERANCE` may cancel this candidate: a 20000×15000 source yields `s = 0.946`, whose candidate is 94.6 % of `sourceWidth` and would be thrown away by a 0.9 gain gate; a 100000×10 source cannot preserve its aspect ratio under `maxSide` at all. In both cases a slightly-too-small or slightly-off-ratio bitmap is the *only* outcome that compresses, and the box it is drawn into is unchanged either way (invariant 1), so a ratio change here shows up as resampling, not as letterboxing.

**The optional candidates — only when `downscale === true`:**

- `pattern-chain` — `ceil(boxWidth × displayFactor × pixelRatio)`. Requires `boxWidth !== null` and `displayFactor !== null` (§4.6).
- `image-attrs` — `ceil(boxWidth × pixelRatio)`. The spec's literal rule. Requires `boxWidth !== null`.

**The ceil absorbs a 1e-6 relative tolerance**, because an SVG scale literal is a truncated decimal: Figma writes `scale(0.0016666667)` for 1/600, which puts `600 × 0.25 × 2` at 300.000006 and a raw `Math.ceil` at 301 — a pixel of noise from a rounding artefact, and a `downscale-on` (§7.4) that asserts 300 against a literally-correct implementation and fails. A candidate within 1e-6 relative of an integer is that integer.

Each optional candidate is bounded in this order, and the order is not free:

1. Clamp high: `w = min(w, sourceWidth)` — upscaling is never a downscale target.
2. If `sourceWidth <= MIN_TARGET_SIDE`, the candidate is dropped. An 8×8 fixture has no useful resample and must not be stretched to 64.
3. Otherwise clamp low: `w = max(w, MIN_TARGET_SIDE)`.
4. If `w >= sourceWidth × MIN_DOWNSCALE_GAIN`, the candidate is dropped — never pay for a 3 % resample.

**Winner and height.** The winner is the smallest surviving candidate, `limits` included; `sizeSource` records which one won. Height follows the source aspect: `h2 = max(1, Math.round(w2 * sourceHeight / sourceWidth))`. If `Math.abs((w2 / h2) / (sourceWidth / sourceHeight) - 1) > ASPECT_TOLERANCE` **and the winner is not `limits`**, the downscale is abandoned (`null`, `sizeSource: 'none'`, `reason: 'aspect-drift'` on an otherwise normal `converted` report): older exports omit `preserveAspectRatio`, where a ratio change would letterbox. No candidate survives → `null`, `sizeSource: 'none'`, encode at intrinsic size.

**`image-attrs` is dead on genuine Figma input, and that is correct.** §8 verifies `boxWidth === sourceWidth` in real exports, so the candidate is `min(2 × sourceWidth, sourceWidth) = sourceWidth`, which step 4 drops. It only ever wins on post-processed input whose `<image width>` was rewritten to the displayed size. The spec's literal rule is implemented and has no work to do on the files the spec was written about — which is the whole reason `pattern-chain` exists ahead of it.

### 4.6 Pattern-chain display factor (pure, best-effort)

```ts
/** image id -> max over usages of (sx * bboxWidth * rootScaleX).
 *  displayedWidth = <image width attr> * factor. Empty map when anything is unresolvable. */
export function resolveDisplayFactors(svg: string): Map<string, number>;
```

```ts
const SVG_ROOT_RE       = /<svg\b[^>]*>/i;
const ROOT_WIDTH_RE     = /\bwidth\s*=\s*(["'])\s*([\d.]+)\s*(?:px)?\s*\1/i;
const ROOT_VIEWBOX_RE   = /\bviewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)/i;
const ANCESTOR_SCALE_RE =
  /<(?!pattern\b|use\b)[A-Za-z][^>]*\btransform\s*=\s*(["'])[^"']*(?:scale|matrix|rotate|skew)/i;
const TRANSFORM_ATTR_RE = /\btransform\s*=\s*(["'])([^"']*)\1/;

const makePatternOpenRe = (): RegExp => /<pattern\b[^>]*\bid\s*=\s*(["'])([^"']*)\1[^>]*>/g;
const makeUseRefRe      = (): RegExp => /<use\b[^>]*?(?:xlink:)?href\s*=\s*(["'])#([^"']+)\1[^>]*>/g;
const makeFillRefRe     = (): RegExp =>
  /<(rect|circle|ellipse)\b([^>]*?)\bfill\s*=\s*(["'])url\(#([^)"']+)\)\3([^>]*?)\/?>/g;
const makeTransformFnRe = (): RegExp => /([A-Za-z]+)\s*\(([^)]*)\)/g;

const SCALE_OF: Record<string, (n: number[]) => { sx: number } | null> = {
  matrix:    (n) => (n.length === 6 && n[1] === 0 && n[2] === 0 ? { sx: n[0] } : null),
  scale:     (n) => (n.length >= 1 ? { sx: n[0] } : null),
  translate: ()  => ({ sx: 1 }),
  rotate:    ()  => null,
  skewX:     ()  => null,
  skewY:     ()  => null,
};

const BBOX_WIDTH_OF: Record<string, (a: Record<string, string>) => number | null> = {
  rect:    (a) => num(a.width),
  circle:  (a) => (num(a.r)  === null ? null : 2 * num(a.r)!),
  ellipse: (a) => (num(a.rx) === null ? null : 2 * num(a.rx)!),
};
```

Algorithm:

1. `ANCESTOR_SCALE_RE.test(svg)` → return an empty map. The disqualifier covers **any** element outside a `<pattern>` body or a `<use>` whose `transform` contains `scale`, `matrix`, `rotate` or `skew` — not just `<g>`. Figma emits transforms directly on the referencing shape (`<rect width="92" height="41" transform="translate(0 0.654785)" fill="url(#pattern0_…)"/>`), and a `scale` or `matrix` there multiplies the displayed size while `BBOX_WIDTH_OF` reads only `width`/`r`/`rx` — the result would be a silently over-downscaled bitmap with no failure signal. A translate-only transform is tolerated, which is what the common Figma case needs; nested `<svg>` and rotate/skew anywhere void the map. `<pattern>`'s own `patternTransform` is not matched by `\btransform` (no word boundary inside `patternTransform`) and is handled by the qualification rule in step 4 instead.
2. `rootScaleX = rootWidth / viewBoxWidth`, or `1` when either is absent. `ROOT_WIDTH_RE` requires the number to **fill** the attribute, so `width="100%"`, `width="30em"` and `width="1e3"` yield no match and `rootScaleX = 1`. A partial-prefix read would take `width="100%"` for `100` and, against a `viewBox` of 1200, downscale every bitmap to a twelfth of the requested size.
3. Index patterns: for each `makePatternOpenRe()` match record `{ id, bodyStart, bodyEnd }` with `bodyEnd = svg.indexOf('</pattern>', bodyStart)`. Self-closing `<pattern …/>` or a body with no `<use>` → skip that pattern and push `'empty-pattern:<id>'` into `warnings` (the Aug-2025 `exportAsync` bug).
4. A pattern qualifies only with `patternContentUnits="objectBoundingBox" width="1" height="1"` and no `patternUnits` or `patternTransform`. A disqualified pattern is skipped; it does not void the map.
5. Inside a qualifying body, `makeUseRefRe()` gives the image id; its `transform` is reduced through `SCALE_OF` (product of the `sx` values in order). Any `null` → skip that pattern.
6. `makeFillRefRe()` over the whole document maps pattern id → referencing shape; `BBOX_WIDTH_OF` gives the bbox width. `<path>` and `<polygon>` are absent from the table on purpose — an unresolvable bbox means that usage is skipped, and the image falls back to `image-attrs`, which on genuine Figma input resolves to no downscale at all (§4.5). Never to a wrong number.
7. `factor = max over usages of (sx × bboxWidth × rootScaleX)`. One bitmap can back many patterns at different sizes; the max is what keeps the largest usage sharp.

### 4.7 Decode and encode (`src/ui/encode-canvas.ts`)

`fetch(dataUrl)` is deliberately not used: its behaviour under Figma's undocumented CSP is unverified, and it would re-materialise the giant base64 string. The Blob route needs no new capability.

```
cleaned payload -> base64ToBytes -> new Blob([bytes], { type: sniffedMime })
  -> createImageBitmap(blob, target ? { resizeWidth, resizeHeight, resizeQuality: 'high' } : undefined)
```

Decoder fallback table, first success wins:

```ts
interface Decoded { drawable: CanvasImageSource; close: () => void }

const DECODERS: ReadonlyArray<{ id: string; run: (b: Blob, t: Target | null) => Promise<Decoded> }> = [
  { id: 'blob-bitmap', run: decodeViaBlobBitmap },   // primary
  { id: 'img-element', run: decodeViaImageElement }, // new Image(); src = objectURL; await decode()
];
```

**Both decoders return the same shape.** `decodeViaBlobBitmap` returns `{ drawable: bitmap, close: () => bitmap.close() }`; `decodeViaImageElement` returns `{ drawable: img, close: () => {} }` and revokes its object URL in `finally`. `HTMLImageElement` has no `close` method (`typeof new Image().close === 'undefined'`), so calling `bitmap.close()` unconditionally in cleanup would throw a `TypeError` **after** a successful encode and turn a good result into `failed` — or escape the per-image boundary entirely, breaking invariant 2. The uniform shape removes the branch rather than guarding it. Both decoders failing → `failed`, `reason: 'decode-failed'`.

Encode:

```js
const canvas = document.createElement('canvas');
canvas.width = w; canvas.height = h;                  // assignment also clears to transparent
const ctx = canvas.getContext('2d', { alpha: true });
ctx.drawImage(decoded.drawable, 0, 0, w, h);
const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', quality / 100));
if (!blob) return { ok: false, reason: 'encoder-returned-null' };
if (blob.type !== 'image/webp') return { ok: false, reason: `webp-unsupported:${blob.type}` };
const dataUrl = await readAsDataUrl(blob);            // FileReader
return { ok: true, dataUrl, bytes: blob.size, width: w, height: h };
```

Guards before any allocation, each returning `{ ok: false, reason }` rather than throwing: `w >= 1 && h >= 1` (`'bad-dimensions'`), `w <= maxSide && h <= maxSide` (`'canvas-side-exceeded'`), `w * h <= maxPixels` (`'canvas-area-exceeded'`).

- `quality` is clamped to 1..100 then divided by 100 at this single boundary. Out-of-range silently becomes the UA default 0.8, so clamping is not cosmetic.
- `blob.type !== 'image/webp'` is the **only** reliable WebP-support detection — an unsupported type silently yields PNG. This is the Safari path.
- `toBlob` calling back `null` is Chromium's silent over-limit failure; it does not throw.
- Memory hygiene in `finally`: `decoded.close()`, `canvas.width = canvas.height = 1`, drop the byte and payload references. Images are processed **strictly sequentially**, never `Promise.all`, so the peak working set is one image.
- **The timeout lives in `transform.ts`, not here.** `createCanvasEncoder()` takes no arguments — `perImageTimeoutMs` is a `TransformOption`, so the orchestrator owns the race and this file owns only the encode. For the same reason the guards below read `CANVAS_LIMITS` directly rather than `options.maxSide`/`maxPixels`; those option-level limits act through the `limits` sizing candidate (§4.5). `no-2d-context` is thrown rather than returned, so it lands in §4.10's "anything unexpected → `String(error)`" instead of widening the closed reason set.
- `withTimeout(p, perImageTimeoutMs)` races a timer, and **racing is not cancelling**. `createImageBitmap` and `canvas.toBlob` keep running after the timer wins and keep their buffers alive; two 4000×3000 RGBA frames is ~96 MB live inside the iframe, which is the "peak working set is one image" claim quietly failing. So the timeout branch is a cleanup branch: attach `p.catch(() => {})` (a late rejection must not be unhandled), then `await p.finally(cleanup)` — `decoded.close()` and `canvas.width = canvas.height = 1` — **before the loop advances to the next image**. The report is written as `failed`/`'timeout'` with the original bytes kept as soon as the timer fires; only the loop's forward progress waits on the settled encode.

### 4.8 Dedupe

The dedupe key is **the cleaned base64 payload string itself**, prefixed by the target width:

```ts
const key = `${target ? target.width : 0}:${cleanPayload}`;   // Map<string, Promise<EncodeOutput>>
```

Exact by construction — no hashing, no collision risk, no crypto in the hot path, and faster than digesting a multi-megabyte buffer. The target width is in the key because the same bitmap can legitimately need two resolutions. The map stores the promise, so a payload used twice is encoded once even under concurrent scheduling, and it lives inside one `transformSvg` call, so a quality change can never serve a stale entry.

Later occurrences get `action: 'deduped'`, `newBytes` copied from the first result, and the identical replacement string. `encoderCalls` counts distinct encoder invocations and is the only assertion that proves work was skipped rather than merely reported as skipped — which is why the test cross-checks it against an independent wrapper count instead of overwriting it with one (§7.5, §7.6).

No hashing anywhere. `crypto.subtle` works in the iframe, but nothing in this design needs it.

### 4.9 Keep-original rule and splicing

```js
const keep = !out.ok || out.bytes >= originalBytes;
```

Strictly `>=`: an equal-size re-encode is lossy artefacts for nothing, and the original already renders everywhere. When kept, the uri region is **not spliced at all**, so those output bytes are identical to the input bytes — a substring property the test asserts directly rather than inferring from size.

```ts
// src/ui/splice.ts
export interface Edit { start: number; end: number; text: string }
export function spliceAll(src: string, edits: Edit[]): string;  // sorts, asserts non-overlap, single pass
```

Collect-then-splice, O(n). An async `String.replace` is impossible, and a per-image `replace` would rescan a 4 MB string each time and could re-match freshly inserted text.

When `images.length === 0`, `transformSvg` returns the input string **by identity** (`result.svg === svg`), so a no-image SVG is provably untouched.

### 4.10 Per-image reason slugs (closed set)

`empty-payload`, `bad-base64`, `unrecognized-bitmap`, `mime:<declared>`, `mime-mismatch:<sniffed>`, `bad-dimensions`, `canvas-side-exceeded`, `canvas-area-exceeded`, `decode-failed`, `encoder-returned-null`, `webp-unsupported:<type>`, `timeout`, `aspect-drift`, `not-smaller`. Anything unexpected → `failed` with `String(error)`.

`reason` is non-null on a `failed`, `skipped-unsupported` or `kept-not-smaller` report, and on exactly one kind of successful one: **`aspect-drift` rides on a `converted` report whose `sizeSource` is `'none'`.** It explains a *missing downscale*, not a failure — the image converted normally at its intrinsic size (§4.5). No other slug may appear on a `converted` or `deduped` report.

---

## 5. Download

### 5.1 Filename (`src/ui/download.ts`, pure)

```ts
const NAME_RULES: ReadonlyArray<[RegExp, string]> = [
  [/[\u0000-\u001f\u007f]/g, ''],        // control chars
  [/[\\/]/g, '-'],                       // path separators
  [/[:*?"<>|]/g, '-'],                   // reserved on Windows, awkward everywhere
  [/\s+/g, ' '],                         // collapse whitespace incl. newlines in node names
  [/^[\s.]+|[\s.]+$/g, ''],              // no leading/trailing dots or spaces
];
const NAME_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const NAME_FALLBACK = 'untitled';
const NAME_MAX = 120;                    // leaves room for ' (12).svg' inside a 255-byte name

export function sanitizeName(raw: string): string;                    // rules in order, truncate, fallback
export function uniqueName(name: string, seen: Set<string>): string;  // 'x.svg', 'x (2).svg', …
```

There is exactly one call site and it fixes who appends the extension:

```ts
const file = uniqueName(sanitizeName(node.name) + '.svg', seen);
```

`sanitizeName` truncates **its own output** to `NAME_MAX` before the suffix is added, and never inspects or strips an existing extension: a node named `Logo.svg` becomes `Logo.svg.svg`. That is correct and unambiguous — the alternative is guessing whether a dot in a layer name was meant as an extension. `uniqueName` receives a name that already ends in `.svg` and inserts its counter before that extension: `x.svg`, `x (2).svg`, `x (3).svg`.

`NAME_RESERVED` matches → prefix `_`. `uniqueName` takes and mutates the caller's `Set`; the key is lower-cased (macOS and Windows filesystems are case-insensitive) while the returned name preserves the original case. Emoji and non-Latin names pass through untouched — they are legal filenames and mangling them would be worse than the risk.

### 5.2 Delivery

```ts
const DOWNLOAD_GAP_MS = 250;
const SVG_MIME = 'image/svg+xml;charset=utf-8';
```

Per file: `URL.createObjectURL(new Blob([svg], { type: SVG_MIME }))` → hidden `<a download=name href=url>` appended to `document.body` → `.click()` → `remove()`. The blob URL is kept in a `Map<name, url>` for the whole done state (the manual links reuse it) and revoked on exactly two events: **the next `export-request`, and `beforeunload`**. Revoking immediately after `click()` is a known race.

**There is no revoke timer.** A timed revoke would silently kill the "Save again" links, which are the entire mitigation for risk 2: a blocked download is undetectable from script, so the user finds out by looking in `~/Downloads` and coming back — usually more than a minute later — and would click a dead link with no feedback, the same silent failure the fallback exists to cover. The URLs are freed when the next export starts or the panel closes, which is soon enough for a plugin iframe holding a handful of blobs.

Sequencing is load-bearing: `for (const f of files) { trigger(f); await sleep(DOWNLOAD_GAP_MS); }`, no gap after the last. Measured: a tight loop is hard-capped at exactly 10 downloads whatever you request (10/11/12/25/60 → 10 every time) and the failure is **silent**; 50 ms → 15/25, 100 ms → 25/25, 150 ms → 60/60. 250 ms is 100 ms with margin. No zip, no user gesture.

**The file is always offered**, even when nothing converted — the spec asks for a download per node and the SVG is valid either way. When zero images converted and at least one image was present, the done state shows a banner naming the reason (`webp-unsupported` → "this browser can't encode WebP; try the Figma desktop app"). The other slugs of §4.10 get the same treatment from a `BANNER_BY_SLUG` table in `main.ts`, with a fallback sentence for an unlisted one, rather than leaving every non-WebP reason silent.

**Manual links are unconditional.** A blocked download is undetectable from script — no exception, no console entry — so detection-based fallback is impossible. Every results row carries a "Save again" link bound to the same blob URL. Above 4 nodes the UI adds: "Figma desktop may ask where to save each file."

---

## 6. UI

`figma.showUI(__html__, { width: 400, height: 560, themeColors: true, title: 'SVG Smash' })`. `themeColors: true` injects the `--figma-color-*` CSS variables; the stylesheet uses them with hardcoded fallbacks.

States are a table, not a cascade:

```ts
type UiState = 'loading' | 'no-selection' | 'idle' | 'working' | 'done' | 'error';

const STATE_VIEW: Record<UiState, { sections: string[]; button: { label: string; enabled: boolean } }> = {
  'loading':      { sections: [],                                   button: { label: 'Export as WebP SVG', enabled: false } },
  'no-selection': { sections: ['controls'],                         button: { label: 'Export as WebP SVG', enabled: false } },
  'idle':         { sections: ['controls'],                         button: { label: 'Export as WebP SVG', enabled: true  } },
  'working':      { sections: ['controls', 'progress'],             button: { label: 'Working…',           enabled: false } },
  'done':         { sections: ['controls', 'results'],              button: { label: 'Export again',       enabled: true  } },
  'error':        { sections: ['controls', 'error'],                button: { label: 'Try again',          enabled: true  } },
};

function applyState(state: UiState): void;   // one job: toggle [data-section] + the button
```

`loading` holds until the first `selection` message arrives, so a never-arriving `init` is visible rather than a frozen blank panel.

Layout, top to bottom:

1. Selection line — "3 layers selected" / "Nothing selected — pick a frame or component on the canvas." In the `no-selection` state the line is followed by `ERROR_TEXT['no-selection']`, rendered from the protocol table rather than retyped. The export button is disabled in that state, so the sandbox's `no-selection` error is otherwise unreachable and the spec's "errors clearly if nothing selected" would rest on the selection line alone.
2. Quality — `<input type="range" min="1" max="100" step="1" value="85">` with a live numeric readout. Sub-label: "85 is a good default. Lower means smaller and softer."
3. Downscale — `<input type="checkbox">`, unchecked, label "Downscale to displayed size ×2", hint "Re-samples oversized bitmaps. Geometry is unchanged."
4. Outline text — `<input type="checkbox">`, label "Outline text", hint "Off keeps `<text>` and font names; viewers need the font installed."
5. Export button, primary, full width.
6. Progress — `<progress max>` plus "Frame 2 of 3 — image 4 of 7", fed by the `svg` message's `index`/`total` and `deps.onProgress`.
7. Results list, one `<li>` per `ImageReport`, two lines each — the image name, then `969 KB → 170 KB (converted)`. The name is `name ?? elementId ?? 'image ' + (index + 1)`; both byte counts come from `formatBytes`. Action labels come from a table: `converted` → "converted", `deduped` → "same as #1", `kept-not-smaller` → "kept, WebP was bigger", `skipped-unsupported` → "skipped, already compressed", `failed` → "kept, encode failed" (amber, not red — the export succeeded). A downscaled item adds `, 1800×410 → 1190×271 (pattern-chain)` after the label. Footer per file: "poster.svg — 3.9 MB → 412 KB (−89%)" plus the "Save again" link. Grand total line when more than one node.
8. Error box — one sentence plus the raw error under `<details>`.

Item 4 is the export panel's switch, labelled exactly as Figma labels it so the two panels read the same. Its initial checked state is written from `DEFAULT_SVG_EXPORT` (§3) at init, never as a `checked` attribute in the template — one declaration of the default, on the wire type. It is read at export time by `readExportSettings()` and travels on `export-request`. `svgIdAttribute` has no control: it is hard-wired on in the sandbox (§3.1).

Changing quality, the downscale toggle or the export switch in the done state re-enables the export button; the shown result is stale. Nothing wires this per control: `STATE_VIEW['done']` already enables the button, so every control has the same effect by construction.

```ts
// src/ui/format.ts — pure
const UNITS: ReadonlyArray<[string, number]> = [['GB', 1e9], ['MB', 1e6], ['KB', 1e3], ['B', 1]];
export function formatBytes(n: number): string;                       // "3.9 MB", "412 KB", "812 B"
export function formatDelta(before: number, after: number): string;   // "−89%" with U+2212
```

Decimal units, matching what Finder shows for the downloaded file. Every number comes from the report; nothing is measured in the DOM and nothing is hardcoded.

`window.onerror` and `window.onunhandledrejection` both move the UI to `error` and post `ui-error`, so a crash is visible rather than a spinner that never stops.

---

## 7. Test plan

`node test/run.mjs`, no test framework, Chromium only (Firefox and WebKit are not cached and would trigger a download). `npm test` builds first.

### 7.1 Determinism

One `chromium.launch()` per run; one context at `deviceScaleFactor: 1`, its viewport set per case from the case's `render` field before each `setContent` (§7.6); every screenshot `{ omitBackground: true, type: 'png', animations: 'disabled' }`. All fixture pixel data from a seeded `mulberry32(0x5EED)` — no `Math.random`, no `Date`, no network. Fixtures are generated in-page on every run (Node 24 has no image codec of any kind) and not committed; the Chromium revision is pinned, so the bytes are stable.

### 7.2 Bundle identity — runs first, before the browser launches

```js
import { extractTransformRegion } from '../scripts/htmlregion.mjs';   // the build's own extractor

const uiHtml   = await readFile('dist/ui.html', 'utf8');
const bundle   = await readFile('dist/transform.bundle.js', 'utf8');
const embedded = extractTransformRegion(uiHtml);      // null when a sentinel is missing
assert(embedded !== null && sha256(embedded) === sha256(bundle));   // exit code 3 on failure
```

Without this, every other assertion is about an artifact nobody ships. Its own exit code separates "stale build" from "real regression". The extractor is **imported, never reimplemented** — a second copy of the newline-trimming rule is how a healthy build gets reported stale.

### 7.3 Fixtures (`test/fixtures.mjs`, generated via `page.evaluate`)

```js
export const IMAGES = [
  { id: 'alpha-png',      w: 160,  h: 160,  mime: 'image/png',  draw: 'quadrants-alpha' },
  { id: 'nonsquare-jpeg', w: 320,  h: 120,  mime: 'image/jpeg', draw: 'gradient' },
  { id: 'photo-png',      w: 600,  h: 400,  mime: 'image/png',  draw: 'noise-blocks' },
  { id: 'huge-png',       w: 4000, h: 3000, mime: 'image/png',  draw: 'noise-blocks' },
  { id: 'tiny-flat-png',  w: 8,    h: 8,    mime: 'image/png',  draw: 'solid' },
  { id: 'skip-webp',      w: 64,   h: 64,   mime: 'image/webp', draw: 'solid' },
  { id: 'skip-gif',       raw: GIF_2PX_BASE64 },     // canvas cannot emit GIF; literal constant
  { id: 'skip-avif',      raw: AVIF_2PX_BASE64 },    // canvas cannot emit AVIF; literal constant
  { id: 'skip-svg',       raw: SVG_DOC_BASE64 },     // 'data:image/svg+xml;base64,' — a nested document
];
```

`quadrants-alpha` draws opaque red, 50 %-alpha blue, a `clearRect` hole and opaque green — the shape whose round-trip was measured to read back `a=255 / a=128 / a=0` exactly.

**`noise-blocks` is pinned, because two readings of "noise" differ by two orders of magnitude in compressibility.** It fills the canvas with **16×16 px** blocks; each block is one flat `rgb(r, g, b)` drawn with a single `fillRect`, the three channels taken from `mulberry32(0x5EED)` and quantised to `Math.floor(rand() * 256)`. There is **no per-pixel noise**: per-pixel RGB noise makes a 4000×3000 PNG ≈41 MB, which would cross the CDP boundary three times per case and turn a size assertion into a memory test. Block noise at that size measures ≈481 KB PNG against ≈395 KB WebP q=85 — an 18 % reduction, not the 40 % an unpinned fixture might suggest, which is why §7.4 asserts the invariant and records the measured ratio instead of guessing a bound.

**The block size must align with WebP's macroblock grid, and 16 is the size those figures describe.** Measured across 4, 6, 8, 10, 12, 16, 20 and 32 px at 4000×3000, compressibility is not monotonic in the block size: only the aligned sizes (4, 8, 16, 32) compress at all, because a misaligned block puts a hard colour edge inside every macroblock and WebP then spends more on that edge than PNG does. 16×16 reproduces the 481 KB / 395 KB pair above exactly; 20×20 measures 398 KB PNG against 573 KB WebP, so the keep rule keeps the PNG and `figma-like`, `huge` and `downscale-on` become unsatisfiable against a correct implementation. The per-size table is recorded in a comment at the `NOISE_BLOCK` constant.

The three `skip-*` raw fixtures exist so the spec's four skip names (webp, avif, gif, svg) are each exercised against the positive `RECODABLE` table rather than assumed.

SVGs are assembled in Figma's real layout: one element per line, flush left, `<g clip-path>` → `<rect fill="url(#pattern…)">`, `<defs>` with patterns and clipPaths, `<image>` last and self-closing.

**`figma-like` pins its geometry, or `downscale-on` asserts something unreachable.** The natural Figma-like choice — a `<rect>` the same size as the bitmap — makes the pattern-chain candidate `2 × 600` → clamped to 600 → dropped by `MIN_DOWNSCALE_GAIN`, so `sizeSource` comes back `'none'` and the case fails against a correct implementation. So: `photo-png` (600×400, `<image width="600" height="400">`) is referenced by two patterns, whose `<rect>`s are **150×100** and **90×60**, each with `<use transform="scale(0.0016666667)">` (`1/600`, 600 px of bitmap across the box). Display factors are `0.0016666667 × 150 × 1 = 0.25` and `0.15`; the max is `0.25`, so the pattern-chain candidate is `ceil(600 × 0.25 × 2) = 300` — provably below `600 × MIN_DOWNSCALE_GAIN = 540` and above `MIN_TARGET_SIDE`. Root `width` equals `viewBox` width, so `rootScaleX === 1`. No element outside a pattern body carries a scaling `transform`, so the §4.6 disqualifier stays quiet.

### 7.4 Case table (`test/cases.mjs`, data only — `run.mjs` never branches on a case name)

"Data only" is a constraint on `run.mjs`, so the table needs a schema the runner can execute blind. Every row is exactly this shape, and `run.mjs` implements each field once:

```ts
{
  id: string,
  svg: string,                       // built by test/fixtures.mjs
  options: { quality: number, downscale?: boolean },
  encoder: 'canvas' | 'bigger' | 'null',   // name, not a function — selected in-page (§7.5)
  budget: 'lossless' | 'flat' | 'photo' | 'resample' | null,   // null = no render comparison
  render: { width: number, height: number } | null,            // viewport + clip; null when budget is null
  expect: {
    converted?: number, skipped?: number, deduped?: number, failed?: number,
    images?: number,                 // total report count — the table asserts it on two rows
    encoderCalls?: number,
    identical?: boolean,             // result.svg === input, strict ===
    sizeSource?: SizeSource,         // asserted on every converted report
    downscaled?: boolean,            // downscaledTo !== null && width < sourceWidth
    downscaledWidths?: number[],     // multiset of downscaled widths — carries `width === 300`
    maxNewRatio?: number,            // newBytes / originalBytes upper bound
    containsVerbatim?: string[],     // substrings that must survive into result.svg
    absent?: string[],               // substrings that must not appear in result.svg
    slugs?: string[],                // multiset of non-null report reasons, order-insensitive
  }
}
```

A function cannot cross `page.evaluate`, which is why `encoder` is a string. `budget: null` marks the cases whose whole claim is `result.svg === input` — rendering a byte-identical pair proves nothing and costs a screenshot pair.

| id | input | options / encoder | budget | expectation |
|---|---|---|---|---|
| `figma-like` | canonical Figma structure, `xlink:href`, double quotes, `photo-png` referenced by **two** patterns (§7.3 geometry), plus `alpha-png` and `skip-webp` | q85, canvas | `flat` | 2 converted, 1 skipped, `encoderCalls === 2`, `maxNewRatio` from the recorded measurement |
| `dup-payload` | the same payload in two separate `<image>` elements | q85, canvas | `flat` | `encoderCalls === 1`, exactly one `deduped`, both output occurrences byte-identical |
| `bare-href` | `href=` with double quotes, no `xlink:` | q85, canvas | `flat` | 1 converted; `containsVerbatim: ['href="data:image/webp']` |
| `single-quote` | `href='data:image/png;base64,…'` | q85, canvas | `flat` | 1 converted; output still uses `'`; `xlink:href` count unchanged |
| `two-per-line` | two `<image …/>` on one physical line, mixed `href` and `xlink:href` | q85, canvas | `flat` | `images.length === 2`, both converted |
| `nested-defs` | `<image>` inside `<pattern>` inside `<defs>` inside `<defs>` | q85, canvas | `flat` | 1 converted |
| `nonsquare` | 320×120 jpeg | q85 + `downscale: true`, canvas | `photo` | converted; `downscaledTo` aspect within `ASPECT_TOLERANCE` of 320/120 |
| `huge` | 4000×3000 png, block noise (§7.3) | q85, canvas | `photo` | converted, `sizeSource === 'none'` (4000×3000 is 4.5 % of the area limit — **no** `limits` clamp, and the toggle is off, so no resample and no `resample` budget), `newBytes < originalBytes`, under a 30 s per-case budget |
| `lossless` | `alpha-png` alone — flat art, where lossless WebP beats PNG | q100, canvas | `lossless` | **every recodable image converted**; a `kept-not-smaller` here fails the case as "control case degenerate" (§7.6) |
| `keep-original` | `tiny-flat-png`, where WebP overhead exceeds PNG | q85, canvas | `null` | `kept-not-smaller`; `identical: true`; the input's full `href="data:…"` substring present verbatim |
| `stub-bigger` | `figma-like` | q85, `bigger` | `null` | every recodable report `kept-not-smaller`, `identical: true` |
| `stub-null` | `figma-like` | q85, `null` | `null` | every recodable report `failed` with `encoder-returned-null`, `identical: true` |
| `skip-only` | `skip-webp` + `skip-gif` + `skip-avif` + `skip-svg` — all four spec skip names | q85, canvas | `null` | four `skipped-unsupported`, `identical: true`, `slugs: ['mime:image/webp','mime:image/gif','mime:image/avif','mime:image/svg+xml']` |
| `no-images` | Figma-shaped SVG with paths and gradients only | q85, canvas | `null` | `identical: true`, `images.length === 0`, `encoderCalls === 0` |
| `malformed` | truncated base64 (`length % 4 === 1`), empty payload, a **GIF payload labelled `image/png`**, and `href="https://…"` — alongside one valid image | q85, canvas | `flat` | `slugs: ['bad-base64','empty-payload','mime-mismatch:image/gif']`; the **valid image still converts**; `absent` includes any rewrite of the external href |
| `downscale-on` | `figma-like` with the §7.3 geometry | q85 + `downscale: true`, canvas | `resample` | `sizeSource === 'pattern-chain'`, `downscaled: true`, `downscaledTo.width === 300`, every `<image width/height>` and `<use transform>` byte-identical to the input |

Two rows deserve their reasoning spelled out, because a plausible alternative is wrong:

- **`malformed` no longer carries a "PNG-labelled JPEG".** JPEG is in `RECODABLE`, so a JPEG declared as `image/png` sniffs clean and converts — it is a success case, not a failure case, and expecting a slug from it fails against a correct implementation. A **GIF** labelled `image/png` is the case that exercises "sniffed mime wins": `skipped-unsupported` / `mime-mismatch:image/gif`.
- **`lossless` is not `figma-like` at q100.** Chromium encodes WebP losslessly at quality 1.0, and lossless WebP of block noise is measurably *larger* than the source PNG (600×400: ≈11.5 KB PNG vs ≈17.3 KB WebP; 4000×3000: ≈481 KB vs ≈3.9 MB). The keep rule then keeps every image, `result.svg === input`, and the tightest diff budget passes on an untouched file — the one case meant to separate "our splice is wrong" from "WebP is lossy" would prove nothing. Flat art is where lossless WebP wins, so the control case uses `alpha-png` and asserts that the conversion actually happened. If that fixture ever stops converting, the remedy is a different fixture, never a relaxed budget.

`images` and `downscaledWidths` are in the schema because two rows of the table above assert exactly those numbers (`images.length === 2` / `=== 0`, `downscaledTo.width === 300`) and no other field can carry them.

`maxNewRatio` values are **recorded, not guessed**: the standing assertion is `newBytes < originalBytes`, every run prints the measured ratio for every case (§7.6), and a row gains a `maxNewRatio` only by copying a measured value with a 15 % margin. Every row that converts at least one image carries one; a row that converts nothing does not, since its ratio is 1.0000 by definition and a bound there would assert nothing. They are re-recorded — never relaxed — after a fixture or encoder change. A hard `0.6` or `0.4` written before the first run is a fixture-dependent coin flip — block noise at 4000×3000 compresses 18 %, per-pixel noise 78 %.

### 7.5 Running the transform

```js
await page.addScriptTag({ path: 'dist/transform.bundle.js' });
const result = await page.evaluate(async ({ svg, options, encoder }) => {
  const ENCODERS = {
    canvas: () => SvgSmash.createCanvasEncoder(),
    bigger: () => SvgSmash.createStubEncoder('bigger'),
    null:   () => SvgSmash.createStubEncoder('null'),
  };
  const enc = SvgSmash.withCallCount(ENCODERS[encoder]());
  const out = await SvgSmash.transformSvg(svg, options, { encoder: enc });

  window.__out = out.svg;                         // stays in the page; never crosses CDP
  return { ...out, svg: undefined, svgLength: out.svg.length,
           identical: out.svg === svg, wrapperCalls: enc.calls };
}, { svg, options, encoder });
```

The real canvas encoder, the real WebP path, the shipped bundle. Three things about this snippet are load-bearing:

- **`wrapperCalls`, not `encoderCalls`.** Spreading `enc.calls` onto `encoderCalls` overwrites the transform's own field with the wrapper's count, so every `encoderCalls` assertion in the case table would measure the wrapper and a transform hard-coding `encoderCalls: 0` would pass. Both numbers are returned and §7.6 asserts they agree; the case table then binds to `encoderCalls`, the field the transform actually computes.
- **The output SVG stays in the page.** `window.__out` is read back only by the render step (§7.6) and by the artifact dump on failure. A 4000×3000 fixture is a multi-megabyte string; returning it would move it across CDP on the result, again into `<img src>`, and again on the render of the original.
- **`identical` is computed in-page.** `result.svg === input` is a strict-identity claim about the transform's return value, and identity does not survive serialisation.

### 7.6 Rendering and pixel assertions

SVG `<image>` elements are not in `document.images` and have no `complete` flag, so both SVGs are rendered through an `<img>` wrapper, which has a real completion signal, at the SVG's intrinsic size:

```js
await page.setViewportSize({ width, height });    // MUST precede setContent
await page.setContent(
  `<style>html,body{margin:0;padding:0;background:transparent}img{display:block}</style>` +
  `<img id="s" src="data:image/svg+xml;base64,${b64(svg)}">`);
await page.evaluate(() => document.getElementById('s').decode());
const shot = await page.screenshot({ omitBackground: true, type: 'png', animations: 'disabled',
                                     clip: { x: 0, y: 0, width, height } });
```

**The document is rebuilt in place rather than through `page.setContent`**, which is the one departure from the snippet above: `setContent` navigates, and a navigation destroys `window.__out` — the output SVG §7.5 deliberately keeps inside the page — along with `window.SvgSmash`. Everything else is unchanged: viewport before content, the `<img>` wrapper, `decode()`, `omitBackground` and `clip`, and both SVGs travel the identical path.

`width`/`height` come from the case's `render` field, and equal the SVG's intrinsic size. `huge` therefore renders in a 4000×3000 viewport: two RGBA frames plus a diff, ~150 MB and a few seconds of `pixelmatch`, which is what its 30 s per-case budget is for. **Setting the viewport is not optional**: measured, a viewport of 300×300 with `clip: { width: 1200, height: 900 }` returns a **300×300** PNG with no error and no warning. Both shots truncate identically, so `pixelmatch` never sees a size mismatch and every difference outside the viewport is invisible — including all but a corner of the 4000×3000 `huge` case. Original and output go through the identical path, so any wrapper effect cancels.

```js
// test/assert.mjs — the only place these numbers live
export const DIFF_BUDGET = {
  lossless: { threshold: 0.02, maxRatio: 0.0005 },  // quality 100 control case
  flat:     { threshold: 0.10, maxRatio: 0.02   },  // quality 85, flat art
  photo:    { threshold: 0.12, maxRatio: 0.02   },  // quality 85, block-noise fixtures at intrinsic size
  resample: { threshold: 0.12, maxRatio: 0.10   },  // downscale-on: a 2x resample moves most pixels slightly
};
```

`threshold` is pixelmatch's normalised YIQ per-pixel distance (its default 0.1 is the "perceptually identical" setting); `maxRatio` bounds how much of the frame may exceed it. Antialiasing detection stays on. Lossy WebP is not bit-identical, so a single exact gate is the wrong instrument; the `lossless` case proves the pipeline is exact when the codec is, separating "our splice is wrong" from "WebP is lossy". **Every run prints the measured ratio for every case**, so the budgets stay evidence-based rather than tuned-until-green.

Four anti-tautology guards, without which an unrenderable output would match an unrenderable original, or a truncated frame would compare clean:

- `nonTransparentRatio(originalShot) > 0.05` — the fixture actually drew something.
- `diffRatio !== 1.0` reported as its own failure ("WebP did not decode"), not as a budget overrun.
- `PNG.sync.read(shot).width === width && .height === height` on **both** shots, failed as its own message ("screenshot truncated to viewport") — the silent-clip failure above.
- `result.encoderCalls === result.wrapperCalls` on every case. The case table asserts `encoderCalls`; this line is what makes that field mean anything (§7.5).

**Alpha**, checked separately because pixelmatch folds alpha into its colour distance and a pure-alpha regression can slip under the threshold:

1. `PNG.sync.read(shot).colorType === 6` on both shots.
2. Known-transparent coordinates from `quadrants-alpha` read exactly `0` in the output.
3. `alphaDelta(original, output).count === 0` for `lossless`; `.max <= 2` for lossy cases. A real alpha loss is a jump to 255, so `max <= 2` is a rounding allowance, not a fudge.

**Size**: `result.newBytes < result.originalBytes` for every case containing a recodable image; every `converted` report must satisfy `newBytes < originalBytes` (the keep rule makes this an invariant, so a violation is a logic bug); and a case with a recorded `maxNewRatio` must also stay under it. No hard ratio is written before it has been measured (§7.4).

**Pure-function cases** run **inside `page.evaluate` against the same bundle, before the render cases** — they are not Node-side. `sanitizeName`, `uniqueName`, `base64ByteLength` and `resolveTargetSize` live in `.ts` sources that Node cannot import (the tests are `.mjs`, there is no ts-node, and `dist/ui.main.js` is an IIFE with no `globalName`, so it exports nothing anywhere). The only reachable copy is `window.SvgSmash`, which is why §4.2 re-exports all four. Without that, the download and sizing tables — the sole coverage of both — cannot run at all.

Coverage: `sanitizeName`/`uniqueName` over a hostile table — `../../etc/passwd`, `a\nb`, `CON`, `"   "`, `""`, 400 chars, `🙂`, `Logo.svg`, two nodes both named `Frame 1`; `base64ByteLength` against known payloads; `resolveTargetSize` against a candidate table that must include, at minimum: an over-limit-by-area source with the toggle **off** (20000×15000 → a `limits` winner at 94.6 % of `sourceWidth`, *not* `null`), an over-limit-by-side source (1000×70000 and 100000×10 → both axes under `maxSide`), an 8×8 source with the toggle on (`null`, never 64), and a genuine-Figma source where `boxWidth === sourceWidth` (`null`, `sizeSource: 'none'`).

### 7.7 Runner and exit codes

Cases run sequentially in table order; each returns `{ name, ok, detail, measured }`; results print as one table with measured diff ratios and byte counts. Failing cases write `test/out/<case>-{original,output,diff}.png` plus `input.svg`, `output.svg`, `report.json` via `node:fs` — `output.svg` is pulled out of the page with `page.evaluate(() => window.__out)` at that point and only at that point, so a passing multi-megabyte case never moves its output across CDP. The browser closes in `finally`.

- `0` — every assertion passed.
- `1` — one or more assertions failed.
- `2` — harness failure: `dist/` missing, browser launch failed, page crash. The message states the remedy.
- `3` — bundle identity failure (§7.2).

Flags: `--case=<id>`, `--keep-out`.

---

## 8. Verified facts — do not re-derive

**Figma API**

- `exportAsync({ format: 'SVG_STRING' })` returns `Promise<string>`; `{ format: 'SVG' }` returns `Uint8Array`. https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/
- `svgOutlineText` defaults to `true` (text exports as paths, no font loading); `svgIdAttribute` defaults to `false`. https://developers.figma.com/docs/plugins/api/ExportSettings/
- **OBSERVED, not documented: with `svgIdAttribute: false`, `exportAsync` drops `<g>` wrappers whose only attribute is `style="mix-blend-mode:…"`.** Seen 2026-09-15 on a real frame — three groups lost (hue, lighten, soft-light), so a gradient that should tint the image underneath painted flat purple over it. The same frame exported from Figma's own UI panel with ids on kept all three. Confirmed 2026-09-15: `exportAsync({ format: 'SVG_STRING', svgIdAttribute: true, svgOutlineText: false })` on the same frame is byte-identical to the UI export outside the image payloads (FNV-1a of the payload-stripped text matches), keeps all three groups, and the transformed file renders with 0 differing pixels against the original in both Chromium 149 and WebKit 26.5. The flag is therefore hard-wired on here (§3.1) rather than offered as a switch — no export wants the paint bug, so there is nothing to choose.
- `exportAsync` comes from `ExportMixin`; `SceneNode` does not guarantee it — narrow with `'exportAsync' in node`.
- Structured clone across the boundary accepts objects, arrays, numbers, strings, booleans, `null`, `undefined`, `Date`, `Uint8Array`; it rejects `Blob`, `ArrayBuffer` and every other TypedArray. UI→plugin needs the `{ pluginMessage }` wrapper, plugin→UI does not. https://developers.figma.com/docs/plugins/creating-ui/
- `documentAccess: "dynamic-page"` is required for new plugins; no-network is exactly `"networkAccess": { "allowedDomains": ["none"] }`; current `api` string is `"1.0.0"`; a local-dev `id` is arbitrary. https://developers.figma.com/docs/plugins/manifest/
- `figma.currentPage.selection` never contains both a node and its descendant and is de-duplicated by Figma. `loadAsync` is needed only for `PageNode`.
- `figma.notify` truncates at 100 characters. `figma.closePlugin()` does not abort execution — `return` right after.
- The **sandbox** is what freezes Figma; long work belongs in the iframe, and the documented remedy for sandbox loops is yielding via `setTimeout`. https://developers.figma.com/docs/plugins/frozen-plugins
- Figma's own `invert-image` sample is a bare inline `<script>` using canvas and `URL.createObjectURL` under `allowedDomains: ["none"]`, so inline script and style are safe. https://github.com/figma/plugin-samples/blob/master/invert-image/decoder.html

**Figma's SVG output** (30+ files sampled from GitHub)

- Both `href` and `xlink:href` ship today and have coexisted 2022→2026; a file is internally consistent but the form is unpredictable, and `xmlns:xlink` is declared even in files that never use it. `xlink:href`: https://raw.githubusercontent.com/microsoft/Sico/HEAD/frontend/packages/shared/src/assets/empty-people.svg · bare `href`: https://raw.githubusercontent.com/HHS/OPRE-OPS/HEAD/frontend/src/images/opre-logo.svg
- Attribute values are always double-quoted in genuine exports; single quotes appear only in post-processed files. Base64 is never line-wrapped in genuine exports. Figma writes one element per line, flush left.
- `<image>` is always inside `<defs>`, always last among its children, always self-closing, always carries `width`/`height`, and is never drawn directly — always shape `fill="url(#patternN)"` → `<pattern>` → `<use>` → `<image>`. https://raw.githubusercontent.com/getumbrel/umbrel-apps-gallery/HEAD/zen/icon.svg
- **`<image width/height` are the intrinsic bitmap pixels, not the displayed size** — verified by decoding PNG IHDR / WebP VP8 headers against the attributes, 7 files, 10 images, exact.
- One `<image>` can back many `<pattern>`s at different sizes; a downscale target must be the max over all referencing patterns. https://raw.githubusercontent.com/in-toto/friends/HEAD/img/Integrations_logo/Testifysec_logo.svg
- `displayedWidth = imageWidthAttr × sx × bboxWidth × rootScaleX`, with `patternContentUnits="objectBoundingBox" width="1" height="1"` making the pattern tile exactly the referencing shape's bbox. `b`/`c` were 0 in 21/21 sampled matrices.
- Mimes in the wild: png 27/35, webp 4/35, jpeg 3/35, gif 1/35. Never assume PNG.
- Only image data URIs appear in genuine exports — masks, clips, filters and gradients contain none; fonts are not embedded.
- Aug-2025 `exportAsync` bug: an empty `<pattern>` whose fill renders nothing. 0 occurrences in 30 sampled files. https://forum.figma.com/report-a-problem-6/rest-api-exportasync-does-not-render-vector-polygon-with-image-fill-44063

**Browser and iframe** (measured in Chrome for Testing 149.0.7827.55 and Electron 43.7.0 / Chromium 150.0.7871.250, in a null-origin `sandbox="allow-scripts"` iframe)

- Present and functional: `createImageBitmap`, `OffscreenCanvas`, `Blob`, `URL.createObjectURL`, `fetch`, `TextEncoder`/`TextDecoder`, `WebAssembly`, `crypto.subtle`; `isSecureContext === true`, inherited from the https parent. `data:` images load, inline `<script>` and `<style>` work.
- `canvas.toBlob('image/webp', q)`: q is 0..1, Chromium's default is exactly 0.8, out-of-range silently becomes that default, alpha survives exactly even at q=0.1, and an unsupported type silently yields PNG → detect via `blob.type`. Safari has no WebP encoder; Firefox since 96. https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob · https://github.com/mdn/browser-compat-data/blob/main/api/HTMLCanvasElement.json
- Canvas limits: max side 65535, max area exactly 268435456 (2²⁸), verified on three axes. Over-limit fails **silently** — draws no-op, `getImageData` returns zeros, `toBlob` calls back `null`, nothing throws.
- 4000×3000 is 4.5 % of the area limit and needs no tiling: ~870 ms to encode at q=0.8.
- `createImageBitmap(blob, { resizeWidth, resizeQuality: 'high' })` downscaled 4000×3000 → 1000×750 in 18 ms. `resizeQuality` defaults to `'low'`. Passing only `resizeWidth` preserves aspect ratio. https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
- `<a download>` + blob + `.click()` works from the iframe with **no user gesture**, provided the iframe carries `allow-downloads`; a blocked download fails silently. A tight loop is capped at exactly 10; 100 ms spacing delivers 25/25, 150 ms delivers 60/60.
- `showSaveFilePicker` throws `SecurityError` in a sandboxed iframe.
- Figma Beta desktop 126.9.7 runs Electron 43.5.1 / Chromium 150.0.7871.250 — ahead of the test rig.

**Test rig**

- Playwright 1.61.1 → chromium rev 1228 → 149.0.7827.55, already cached. https://raw.githubusercontent.com/microsoft/playwright/v1.61.1/packages/playwright-core/browsers.json
- `page.screenshot({ omitBackground: true })` yields RGBA (`colorType 6`) with untouched regions at `[0,0,0,0]`. `href` and `xlink:href` render pixel-identically (diff 0/40000). Two screenshots 350 ms apart with `animations: 'disabled'` differ by 0 pixels.
- Node 24 has no image codec of any kind — every encode and every fixture must be produced inside Chromium.
- `pixelmatch@7` is ESM-first and works under Node 24 as `import pixelmatch from 'pixelmatch'`.

---

## 9. README (shell)

Must contain: install (`npm install`, then `npm run build`), import into Figma (Plugins → Development → Import plugin from manifest… → pick `manifest.json`), usage (select one or more frames, set quality, press Export), the note that Figma desktop may show one Save dialog per file, the note that the plugin never writes to the document and has no network access, and `npm test` with what the exit codes mean.

---

## 10. Open risks

| # | Risk | Status | Mitigation here |
|---|---|---|---|
| 1 | The spec's downscale rule is a no-op: `<image width/height>` is the intrinsic size, so `min(intrinsic, 2 × attr)` never shrinks anything | VERIFIED conflict between spec text and measurement | §4.5 candidate table — spec rule implemented verbatim as `image-attrs`, which consequently resolves to `null` on every genuine export and can never appear as a `sizeSource` there; `pattern-chain` is added ahead of it so the toggle does work; `sizeSource` is in every report and asserted in `downscale-on`. |
| 2 | Figma's iframe may lack `allow-downloads`; a blocked download is undetectable from script | UNVERIFIED (figma.com JS unreadable; shipped plugins rely on this exact pattern) | "Save again" link on every row, unconditional. First smoke test after install is a single-node export. |
| 3 | Figma desktop likely shows a Save dialog per file (Electron default; Figma's shell contains no `will-download`/`setSavePath` handler) → N nodes = N dialogs | UNVERIFIED inference | 250 ms sequencing, warning above 4 nodes, README says so. Worth a 2-minute manual check before locking the per-node UX. |
| 4 | No documented byte cap on `figma.ui.postMessage`; a 3.9 MB string is the payload | UNVERIFIED | One node per message, never an array. If a cap surfaces, chunking is protocol-local with no transform impact. |
| 5 | Message queueing before iframe load | UNVERIFIED | `ui-ready` handshake; nothing is buffered and nothing is assumed. |
| 6 | Safari (web Figma) has no WebP encoder | VERIFIED unsupported | `blob.type` check → every image `failed`/`webp-unsupported`, banner in the done state, file still offered. |
| 7 | Ancestor or sibling `transform` scaling would break displayed-size math | known gap | Whole-document disqualifier (§4.6 step 1) covers **any** element outside a pattern body or `<use>`, not just `<g>` — Figma puts transforms on the referencing shape itself. Map voided → `sizeSource: 'none'`. Conservative: never blurrier than asked. |
| 8 | Rotated or skewed image fills (`b`/`c` non-zero) | not observed in 21 matrices, not proven impossible | `SCALE_OF` returns `null` for rotate/skew and for a matrix with non-zero `b`/`c`; geometry is never rewritten either way. |
| 9 | Aug-2025 empty-`<pattern>` export bug | rare | Detected, pushed into `warnings`, transform proceeds. |
| 10 | Lossy WebP at q=85 was never pixel-compared against source in research | UNVERIFIED | `lossless` control case plus printed measured ratios every run. |
| 11 | Post-processed input (SVGO, vecta.io, prettier): one line, indented, `<?xml?>` prolog, renamed ids, explicit `</image>`, wrapped base64, percentage root `width` | observed in the wild | The transform matches attribute values and ignores structure; whitespace is stripped before decode. Renamed ids disable the downscale for that image (`sizeSource: 'none'` — `image-attrs` resolves to `null` on any input whose `<image width>` is still the intrinsic size, §4.5): a quality regression, never a correctness one. A percentage root `width` is the larger path and is closed separately — `ROOT_WIDTH_RE` requires the number to fill the attribute, so `width="100%"` gives `rootScaleX = 1` instead of reading as `100`. |
| 12 | A `</script>` or `<!--` sequence in a bundle would truncate `dist/ui.html` | latent | Build-time guard throws (§2.3). |
| 13 | Animated GIF re-encoded as one WebP frame would lose the animation | real | GIF is not in `RECODABLE` — always `skipped-unsupported`. |
| 14 | `typescript` 7.x is the new native compiler with an unproven flag surface here | current | Pinned to 5.9.3; revisit deliberately. |
| 15 | Spec says the sandbox sends **bytes**; this design sends a `string` | deliberate deviation | `exportAsync({ format: 'SVG_STRING' })` returns a `string` directly (§8), so the string route removes a `Uint8Array` round-trip and a `TextDecoder` and changes nothing downstream — the transform's input is a string either way. |
| 16 | Spec says dedupe **by hash**; this design dedupes by the exact cleaned payload string | deliberate deviation | Exact by construction: no collision class to reason about, no digest over a multi-megabyte buffer, and `crypto.subtle` stays out of the hot path (§4.8). |
