#!/usr/bin/env node
// test/run.mjs — the runner (§7.1, §7.2, §7.5, §7.7).
//
// Exit codes: 0 every assertion passed · 1 assertions failed · 2 harness failure ·
// 3 the shipped dist/ui.html does not embed dist/transform.bundle.js.
// Flags: --case=<id>, --keep-out.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { chromium } from 'playwright';

import { extractTransformRegion } from '../scripts/htmlregion.mjs';
import {
  buildCases,
  PURE_B64_CASES,
  PURE_NAME_CASES,
  PURE_SIZING_CASES,
  PURE_UNIQUE_CASES,
} from './cases.mjs';
import { ALPHA_PROBES, buildSvgs, generatePayloads } from './fixtures.mjs';
import { expectFailures, invariantFailures, pixelFailures, runPureCases } from './assert.mjs';
import { renderShot, resetPage } from './render.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_HTML = path.join(ROOT, 'dist', 'ui.html');
const BUNDLE = path.join(ROOT, 'dist', 'transform.bundle.js');
const OUT_DIR = path.join(ROOT, 'test', 'out');

const EXIT = { pass: 0, failed: 1, harness: 2, identity: 3 };
const CASE_BUDGET_MS = 30_000;
const HARNESS_ERROR_RE =
  /Target (page|closed)|browser has been closed|crashed|Protocol error|Execution context was destroyed/i;

class HarnessError extends Error {}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const rel = (file) => path.relative(ROOT, file);

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const FLAG_RULES = [
  { match: (a) => a.startsWith('--case='), apply: (f, a) => ({ ...f, case: a.slice('--case='.length) }) },
  { match: (a) => a === '--keep-out', apply: (f) => ({ ...f, keepOut: true }) },
];

function parseFlags(argv) {
  return argv.reduce((flags, arg) => {
    const rule = FLAG_RULES.find((r) => r.match(arg));
    if (!rule) throw new HarnessError(`unknown flag ${arg} — supported: --case=<id>, --keep-out`);
    return rule.apply(flags, arg);
  }, { case: null, keepOut: false });
}

// ---------------------------------------------------------------------------
// §7.2 Bundle identity — runs first, before the browser launches
// ---------------------------------------------------------------------------

async function readOrThrow(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new HarnessError(`${rel(file)} is missing — run \`npm run build\` first.`);
  }
}

/** Returns null when the shipped HTML embeds exactly this bundle, else the identity failure. */
async function bundleIdentityFailure() {
  const html = await readOrThrow(UI_HTML);
  const bundle = await readOrThrow(BUNDLE);
  const embedded = extractTransformRegion(html);
  if (embedded === null) {
    return `${rel(UI_HTML)} has no transform region — a sentinel is missing. Rebuild with \`npm run build\`.`;
  }
  if (sha256(embedded) !== sha256(bundle)) {
    return (
      `${rel(UI_HTML)} embeds a different transform bundle than ${rel(BUNDLE)} ` +
      `(${sha256(embedded).slice(0, 12)} vs ${sha256(bundle).slice(0, 12)}). ` +
      'The build is stale — run `npm run build`.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// §7.5 Running the transform
// ---------------------------------------------------------------------------

const transformInPage = async ({ svg, options, encoder, contains, absent }) => {
  const ENCODERS = {
    canvas: () => SvgSmash.createCanvasEncoder(),
    bigger: () => SvgSmash.createStubEncoder('bigger'),
    null: () => SvgSmash.createStubEncoder('null'),
  };
  const enc = SvgSmash.withCallCount(ENCODERS[encoder]());
  const out = await SvgSmash.transformSvg(svg, options, { encoder: enc });

  window.__out = out.svg; // stays in the page; never crosses CDP

  // For every occurrence in the output, the index of the first occurrence carrying the same
  // payload — the exact, cheap proof that a deduped image reused the first result byte for byte.
  const firstByPayload = new Map();
  const outputFirstSame = SvgSmash.scanImages(out.svg).map((hit, i) => {
    if (!firstByPayload.has(hit.payloadRaw)) firstByPayload.set(hit.payloadRaw, i);
    return firstByPayload.get(hit.payloadRaw);
  });

  return {
    ...out,
    svg: undefined,
    svgLength: out.svg.length,
    identical: out.svg === svg,
    wrapperCalls: enc.calls,
    outputFirstSame,
    contains: contains.map((needle) => out.svg.includes(needle)),
    absentHits: absent.map((needle) => out.svg.includes(needle)),
  };
};

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

async function runCase(page, testCase, consts) {
  const startedAt = Date.now();
  await resetPage(page);

  const expect = testCase.expect;
  const result = await page.evaluate(transformInPage, {
    svg: testCase.svg,
    options: testCase.options,
    encoder: testCase.encoder,
    contains: expect.containsVerbatim ?? [],
    absent: expect.absent ?? [],
  });

  const failures = [...expectFailures(result, expect), ...invariantFailures(result, consts)];
  const measured = {
    diffRatio: null,
    originalBytes: result.originalBytes,
    newBytes: result.newBytes,
    encoderCalls: result.encoderCalls,
  };
  const shots = {};

  if (testCase.budget !== null) {
    const size = testCase.render;
    const original = await renderShot(page, testCase.svg, size);
    const output = await renderShot(page, null, size);
    shots.original = original.buf;
    shots.output = output.buf;
    for (const [label, shot] of [['original', original], ['output', output]]) {
      if (shot.decodeError) failures.push(`${label} SVG failed to decode: ${shot.decodeError}`);
    }
    const pixels = pixelFailures({
      originalBuf: original.buf,
      outputBuf: output.buf,
      budget: testCase.budget,
      size,
      probes: ALPHA_PROBES[testCase.id] ?? [],
    });
    measured.diffRatio = pixels.diffRatio;
    if (pixels.diffPng) shots.diff = PNG.sync.write(pixels.diffPng);
    failures.push(...pixels.failures);
  }

  const ms = Date.now() - startedAt;
  if (ms > CASE_BUDGET_MS) failures.push(`case took ${ms} ms, over the ${CASE_BUDGET_MS} ms budget`);

  return { name: testCase.id, ok: failures.length === 0, detail: failures.join(' | '), measured, shots, result };
}

// ---------------------------------------------------------------------------
// Artifacts (§7.7)
// ---------------------------------------------------------------------------

async function writeArtifacts(page, testCase, row) {
  await mkdir(OUT_DIR, { recursive: true });
  const at = (suffix) => path.join(OUT_DIR, `${testCase.id}-${suffix}`);
  for (const [kind, buf] of Object.entries(row.shots)) await writeFile(at(`${kind}.png`), buf);
  await writeFile(at('input.svg'), testCase.svg);
  // pulled out of the page here and only here, so a passing case never moves its output across CDP
  const output = await page.evaluate(() => window.__out);
  if (typeof output === 'string') await writeFile(at('output.svg'), output);
  await writeFile(
    at('report.json'),
    JSON.stringify(
      { case: testCase.id, options: testCase.options, encoder: testCase.encoder, budget: testCase.budget,
        expect: testCase.expect, failures: row.detail.split(' | '), measured: row.measured, result: row.result },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const COLUMNS = [
  { head: 'case', of: (r) => r.name },
  { head: 'result', of: (r) => (r.ok ? 'ok' : 'FAIL') },
  { head: 'diff', of: (r) => (r.measured && r.measured.diffRatio !== null ? r.measured.diffRatio.toFixed(5) : '-') },
  { head: 'new/orig', of: (r) => (r.measured ? (r.measured.newBytes / r.measured.originalBytes).toFixed(4) : '-') },
  { head: 'bytes', of: (r) => (r.measured ? `${r.measured.originalBytes} -> ${r.measured.newBytes}` : '-') },
  { head: 'encodes', of: (r) => (r.measured ? String(r.measured.encoderCalls) : '-') },
];

function printTable(rows) {
  const table = [COLUMNS.map((c) => c.head), ...rows.map((r) => COLUMNS.map((c) => c.of(r)))];
  const widths = COLUMNS.map((_, i) => Math.max(...table.map((line) => line[i].length)));
  for (const line of table) console.log(line.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
  console.log('');
  for (const row of rows.filter((r) => !r.ok)) console.log(`FAIL ${row.name}: ${row.detail}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const identity = await bundleIdentityFailure();
  if (identity !== null) {
    console.error(identity);
    return EXIT.identity;
  }

  if (!flags.keepOut) await rm(OUT_DIR, { recursive: true, force: true });

  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    throw new HarnessError(`could not launch Chromium: ${error.message}. Run \`npx playwright install chromium\`.`);
  }

  const rows = [];
  let failedCases = 0;
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addScriptTag({ path: BUNDLE });

    // the constants live in the bundle (§4.1); the test reads them rather than restating them
    const consts = await page.evaluate(() => ({ ASPECT_TOLERANCE: SvgSmash.ASPECT_TOLERANCE }));

    rows.push(
      ...(await runPureCases(page, {
        names: PURE_NAME_CASES,
        unique: PURE_UNIQUE_CASES,
        b64: PURE_B64_CASES,
        sizing: PURE_SIZING_CASES,
      })),
    );

    const svgs = buildSvgs(await generatePayloads(page));
    const all = buildCases(svgs);
    const cases = flags.case === null ? all : all.filter((c) => c.id === flags.case);
    if (cases.length === 0) {
      throw new HarnessError(`no case named ${flags.case} — known: ${all.map((c) => c.id).join(', ')}`);
    }

    for (const testCase of cases) {
      let row;
      try {
        row = await runCase(page, testCase, consts);
      } catch (error) {
        if (HARNESS_ERROR_RE.test(String(error))) throw new HarnessError(`case ${testCase.id}: ${error.message}`);
        row = { name: testCase.id, ok: false, detail: `threw: ${error.stack ?? error}`, measured: null, shots: {}, result: null };
      }
      if (pageErrors.length > 0) {
        row.ok = false;
        row.detail = [row.detail, `page errors: ${pageErrors.join(' | ')}`].filter(Boolean).join(' | ');
        pageErrors.length = 0;
      }
      if (!row.ok) await writeArtifacts(page, testCase, row);
      rows.push(row);
    }
    failedCases = rows.filter((r) => !r.ok).length;
  } finally {
    await browser.close();
  }

  printTable(rows);
  if (failedCases > 0) console.error(`\n${failedCases} failing — artifacts in ${rel(OUT_DIR)}`);
  return failedCases === 0 ? EXIT.pass : EXIT.failed;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof HarnessError ? `harness failure: ${error.message}` : `harness failure: ${error.stack ?? error}`);
  process.exitCode = EXIT.harness;
}
