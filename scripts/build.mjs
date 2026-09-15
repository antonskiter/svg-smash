// scripts/build.mjs — esbuild driver, HTML composition, watch. See DESIGN.md §2.

import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { TRANSFORM_BEGIN, TRANSFORM_END, extractTransformRegion } from './htmlregion.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (rel) => join(ROOT, rel);

const COMMON = { bundle: true, target: 'es2020', format: 'iife', platform: 'browser',
                 charset: 'utf8', legalComments: 'none', logLevel: 'warning' };

const TARGETS = [
  { id: 'code',      entry: 'src/code.ts',         outfile: 'dist/code.js' },
  { id: 'transform', entry: 'src/ui/transform.ts', outfile: 'dist/transform.bundle.js',
    globalName: 'SvgSmash', sourcemap: 'inline' },
  { id: 'uimain',    entry: 'src/ui/main.ts',      outfile: 'dist/ui.main.js' },
];

const TEMPLATE = 'src/ui/ui.template.html';
const HTML_OUT = 'dist/ui.html';
const BUILD_JSON = 'dist/build.json';

const SENTINEL = { transform: '<!--@TRANSFORM@-->', ui: '<!--@UI@-->' };

/** Sequences that end the enclosing <script> or open an HTML comment. */
const FORBIDDEN_IN_SCRIPT = ['</script', '<!--'];

const WATCH_DEBOUNCE_MS = 50;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Bundle one target and return its bytes without writing them. */
async function buildTarget({ id, entry, outfile, ...overrides }) {
  const result = await esbuild.build({
    ...COMMON,
    ...overrides,
    entryPoints: [abs(entry)],
    outfile: abs(outfile),
    write: false,
  });
  const [file] = result.outputFiles;
  if (!file) throw new Error(`esbuild produced no output for target '${id}'`);
  return { id, outfile, contents: file.contents, text: file.text };
}

function assertInjectable(js, label) {
  for (const seq of FORBIDDEN_IN_SCRIPT) {
    if (js.includes(seq)) {
      throw new Error(`${label} contains ${JSON.stringify(seq)}; inlining it would truncate ${HTML_OUT}`);
    }
  }
}

/** Replace the first sentinel occurrence literally — a string replacement would expand
 *  `$&`, `` $` `` and `$1`, all of which occur in bundled JS. */
function inject(html, sentinel, tag) {
  if (!html.includes(sentinel)) throw new Error(`${TEMPLATE} is missing the ${sentinel} sentinel`);
  return html.replace(sentinel, () => tag);
}

function composeHtml(template, transformJs, uiMainJs) {
  const transformTag =
    '<script>' + TRANSFORM_BEGIN + '\n' + transformJs + '\n' + TRANSFORM_END + '</' + 'script>';
  const uiTag = '<script>' + uiMainJs + '</' + 'script>';
  return inject(inject(template, SENTINEL.transform, transformTag), SENTINEL.ui, uiTag);
}

async function buildAll() {
  const started = Date.now();
  const built = await Promise.all(TARGETS.map((target) => buildTarget(target)));
  const byId = new Map(built.map((b) => [b.id, b]));
  const transform = byId.get('transform');
  const uimain = byId.get('uimain');

  assertInjectable(transform.text, transform.outfile);
  assertInjectable(uimain.text, uimain.outfile);

  const html = composeHtml(await readFile(abs(TEMPLATE), 'utf8'), transform.text, uimain.text);
  if (extractTransformRegion(html) !== transform.text) {
    throw new Error(`the transform region of ${HTML_OUT} does not read back as ${transform.outfile}`);
  }

  await mkdir(abs('dist'), { recursive: true });
  for (const b of built) await writeFile(abs(b.outfile), b.contents);
  await writeFile(abs(HTML_OUT), html);
  await writeFile(
    abs(BUILD_JSON),
    JSON.stringify({ transformSha256: sha256(transform.contents), builtAt: new Date().toISOString() }, null, 2) + '\n',
  );

  return { ms: Date.now() - started, htmlBytes: Buffer.byteLength(html) };
}

const report = (error) =>
  console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`);

async function once() {
  const { ms, htmlBytes } = await buildAll();
  console.log(`built ${TARGETS.length} bundles and ${HTML_OUT} (${htmlBytes} bytes) in ${ms} ms`);
}

async function main() {
  if (!process.argv.includes('--watch')) {
    await once();
    return;
  }
  await once().catch(report);
  let timer = null;
  watch(abs('src'), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      once().catch(report);
    }, WATCH_DEBOUNCE_MS);
  });
  console.log('watching src/ — Ctrl-C to stop');
}

main().catch((error) => {
  report(error);
  process.exitCode = 1;
});
