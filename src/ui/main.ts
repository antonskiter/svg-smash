import { DEFAULT_SVG_EXPORT, ERROR_TEXT } from '../protocol';
import type { CodeToUi, SelectionItem, SvgExportSettings, UiToCode } from '../protocol';
import { createBlobUrl, downloadSequenced, revokeAll, sanitizeName, uniqueName } from './download';
import { formatBytes, formatDelta } from './format';
import type { ImageAction, ImageReport, TransformOptions, TransformResult } from './types';

/** The transform ships as its own IIFE bundle (§2.2); importing it would inline a second copy. */
declare const SvgSmash: typeof import('./transform');

// ---------------------------------------------------------------- state table

type UiState = 'loading' | 'no-selection' | 'idle' | 'working' | 'done' | 'error';

const STATE_VIEW: Record<UiState, { sections: string[]; button: { label: string; enabled: boolean } }> = {
  loading: { sections: [], button: { label: 'Export as WebP SVG', enabled: false } },
  'no-selection': { sections: ['controls'], button: { label: 'Export as WebP SVG', enabled: false } },
  idle: { sections: ['controls'], button: { label: 'Export as WebP SVG', enabled: true } },
  working: { sections: ['controls', 'progress'], button: { label: 'Working…', enabled: false } },
  done: { sections: ['controls', 'results'], button: { label: 'Export again', enabled: true } },
  error: { sections: ['controls', 'error'], button: { label: 'Try again', enabled: true } },
};

const ACTION_LABEL: Record<ImageAction, string> = {
  converted: 'converted',
  deduped: 'same as #1',
  'kept-not-smaller': 'kept, WebP was bigger',
  'skipped-unsupported': 'skipped, already compressed',
  failed: 'kept, encode failed',
};

/** Keyed by the part of the reason slug before ':'. */
const BANNER_BY_SLUG: Record<string, string> = {
  'webp-unsupported': 'This browser can’t encode WebP; try the Figma desktop app.',
  'not-smaller': 'WebP came out bigger than the original for every image, so nothing changed.',
  mime: 'Every image is already in a compressed format, so nothing was re-encoded.',
  'mime-mismatch': 'Every image is already in a compressed format, so nothing was re-encoded.',
  timeout: 'Encoding ran out of time, so the images were left as they were.',
};
const BANNER_FALLBACK = 'No image could be converted. The file is unchanged.';
const MANY_FILES = 4;

const REASON_SHOWN: ReadonlySet<ImageAction> = new Set<ImageAction>(['failed', 'skipped-unsupported']);

// -------------------------------------------------------------------- the DOM

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
};

const selectionLine = el<HTMLParagraphElement>('selection-line');
const selectionHint = el<HTMLParagraphElement>('selection-hint');
const qualityInput = el<HTMLInputElement>('quality');
const qualityValue = el<HTMLSpanElement>('quality-value');
const downscaleInput = el<HTMLInputElement>('downscale');

/** One checkbox per SvgExportSettings key, so the wire shape and the DOM cannot drift. */
const EXPORT_SETTING_INPUT: Record<keyof SvgExportSettings, HTMLInputElement> = {
  svgIdAttribute: el<HTMLInputElement>('svg-id-attribute'),
  svgOutlineText: el<HTMLInputElement>('svg-outline-text'),
};

const exportButton = el<HTMLButtonElement>('export');
const progressBar = el<HTMLProgressElement>('progress');
const progressText = el<HTMLParagraphElement>('progress-text');
const resultsRoot = el<HTMLDivElement>('results');
const resultsBanner = el<HTMLParagraphElement>('results-banner');
const resultsMany = el<HTMLParagraphElement>('results-many');
const resultsTotal = el<HTMLParagraphElement>('results-total');
const errorText = el<HTMLParagraphElement>('error-text');
const errorDetails = el<HTMLDetailsElement>('error-details');
const errorRaw = el<HTMLPreElement>('error-raw');

let state: UiState = 'loading';

/** One job: toggle [data-section] and the button. */
function applyState(next: UiState): void {
  state = next;
  const view = STATE_VIEW[next];
  for (const section of document.querySelectorAll<HTMLElement>('[data-section]')) {
    section.hidden = !view.sections.includes(section.dataset['section'] ?? '');
  }
  exportButton.textContent = view.button.label;
  exportButton.disabled = !view.button.enabled;
}

// ------------------------------------------------------------------- run data

interface FileResult {
  name: string;
  url: string;
  result: TransformResult;
}

let selection: SelectionItem[] = [];
let files: FileResult[] = [];
let blobUrls = new Map<string, string>();
let seenNames = new Set<string>();
let fileTotal = 0;
let fileDone = 0;
let fatal: string | null = null;
let nodeErrors: string[] = [];

const post = (msg: UiToCode): void => {
  parent.postMessage({ pluginMessage: msg }, '*');
};

const exportable = (): SelectionItem[] => selection.filter((item) => item.exportable);

const readOptions = (): TransformOptions => ({
  quality: Number(qualityInput.value),
  downscale: downscaleInput.checked,
});

/** Read at export time like the options above; these ones ride to the sandbox on `export-request`. */
const readExportSettings = (): SvgExportSettings => ({
  svgIdAttribute: EXPORT_SETTING_INPUT.svgIdAttribute.checked,
  svgOutlineText: EXPORT_SETTING_INPUT.svgOutlineText.checked,
});

// ------------------------------------------------------------------ rendering

function renderSelection(): void {
  const count = exportable().length;
  selectionLine.textContent =
    count === 0
      ? 'Nothing selected — pick a frame or component on the canvas.'
      : `${count} layer${count === 1 ? '' : 's'} selected`;
  selectionHint.textContent = ERROR_TEXT['no-selection'];
  selectionHint.hidden = count !== 0;
}

function renderProgress(imageDone: number, imageTotal: number): void {
  const current = Math.min(fileDone + 1, Math.max(fileTotal, 1));
  progressBar.max = Math.max(fileTotal, 1);
  progressBar.value = fileDone + (imageTotal > 0 ? imageDone / imageTotal : 0);
  progressText.textContent =
    imageTotal > 0
      ? `Frame ${current} of ${fileTotal} — image ${imageDone} of ${imageTotal}`
      : `Frame ${current} of ${fileTotal}`;
}

function describeAction(report: ImageReport): string {
  const label = ACTION_LABEL[report.action];
  const resample =
    report.downscaledTo !== null && report.sourceWidth !== null && report.sourceHeight !== null
      ? `, ${report.sourceWidth}×${report.sourceHeight} → ${report.downscaledTo.width}×${report.downscaledTo.height} (${report.sizeSource})`
      : '';
  const reason = report.reason !== null && REASON_SHOWN.has(report.action) ? ` (${report.reason})` : '';
  return label + resample + reason;
}

/** Figma writes the fill's own file name into `data-name`; the id and the index are fallbacks. */
const imageName = (report: ImageReport): string =>
  report.name ?? report.elementId ?? `image ${report.index + 1}`;

function line(parent: HTMLElement, className: string, text: string): void {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  parent.appendChild(span);
}

function reportItem(report: ImageReport): HTMLLIElement {
  const item = document.createElement('li');
  if (report.action === 'failed') item.className = 'failed';
  line(item, 'name', imageName(report));
  line(
    item,
    'size',
    `${formatBytes(report.originalBytes)} → ${formatBytes(report.newBytes)} (${describeAction(report)})`,
  );
  return item;
}

function reportList(reports: ImageReport[]): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'images';
  for (const report of reports) list.appendChild(reportItem(report));
  return list;
}

function fileFooter(file: FileResult): HTMLParagraphElement {
  const foot = document.createElement('p');
  foot.className = 'file-foot';
  const summary = document.createElement('span');
  summary.textContent = `${file.name} — ${formatBytes(file.result.originalBytes)} → ${formatBytes(
    file.result.newBytes,
  )} (${formatDelta(file.result.originalBytes, file.result.newBytes)})`;
  const link = document.createElement('a');
  link.href = file.url;
  link.download = file.name;
  link.textContent = 'Save again';
  foot.appendChild(summary);
  foot.appendChild(link);
  return foot;
}

function bannerText(reports: ImageReport[]): string | null {
  const converted = reports.filter((r) => r.action === 'converted' || r.action === 'deduped');
  if (reports.length === 0 || converted.length > 0) return null;
  const counts = new Map<string, number>();
  for (const report of reports) {
    if (report.reason === null) continue;
    const slug = report.reason.split(':')[0] ?? report.reason;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  let top: string | null = null;
  for (const [slug, n] of counts) if (top === null || n > (counts.get(top) ?? 0)) top = slug;
  return (top === null ? undefined : BANNER_BY_SLUG[top]) ?? BANNER_FALLBACK;
}

function renderResults(): void {
  resultsRoot.textContent = '';
  const reports = files.flatMap((file) => file.result.images);

  for (const message of nodeErrors) {
    const line = document.createElement('p');
    line.className = 'danger';
    line.textContent = message;
    resultsRoot.appendChild(line);
  }

  for (const file of files) {
    const block = document.createElement('div');
    block.className = 'file';
    if (file.result.images.length > 0) block.appendChild(reportList(file.result.images));
    block.appendChild(fileFooter(file));
    resultsRoot.appendChild(block);
  }

  const banner = bannerText(reports);
  resultsBanner.textContent = banner ?? '';
  resultsBanner.hidden = banner === null;
  resultsMany.hidden = files.length <= MANY_FILES;

  const before = files.reduce((sum, f) => sum + f.result.originalBytes, 0);
  const after = files.reduce((sum, f) => sum + f.result.newBytes, 0);
  resultsTotal.textContent = `All files — ${formatBytes(before)} → ${formatBytes(after)} (${formatDelta(
    before,
    after,
  )})`;
  resultsTotal.hidden = files.length <= 1;
}

function showError(message: string, raw: string | null): void {
  errorText.textContent = message;
  errorRaw.textContent = raw ?? '';
  errorDetails.hidden = raw === null;
}

function crash(message: string): void {
  showError('Something went wrong in the plugin UI.', message);
  applyState('error');
  post({ type: 'ui-error', message });
}

// ------------------------------------------------------------------ messaging

type Handlers = {
  [K in CodeToUi['type']]: (msg: Extract<CodeToUi, { type: K }>) => Promise<void> | void;
};

async function transformFile(msg: Extract<CodeToUi, { type: 'svg' }>): Promise<void> {
  fileTotal = msg.total;
  fileDone = msg.index; // frames finished, straight from the message — a failed node is skipped
  const result = await SvgSmash.transformSvg(msg.svg, readOptions(), {
    encoder: SvgSmash.createCanvasEncoder(),
    onProgress: renderProgress,
  });
  const name = uniqueName(sanitizeName(msg.nodeName) + '.svg', seenNames);
  const url = createBlobUrl(result.svg);
  blobUrls.set(name, url);
  files.push({ name, url, result });
  fileDone = msg.index + 1;
  renderProgress(0, 0);
}

async function finishExport(): Promise<void> {
  if (fatal !== null) {
    applyState('error');
    return;
  }
  if (files.length === 0) {
    applyState(exportable().length === 0 ? 'no-selection' : 'idle');
    return;
  }
  renderResults();
  applyState('done');
  await downloadSequenced(files.map((file) => ({ name: file.name, url: file.url })));
  post({
    type: 'ui-done',
    files: files.length,
    originalBytes: files.reduce((sum, f) => sum + f.result.originalBytes, 0),
    newBytes: files.reduce((sum, f) => sum + f.result.newBytes, 0),
    failed:
      nodeErrors.length +
      files.reduce((sum, f) => sum + f.result.images.filter((i) => i.action === 'failed').length, 0),
  });
}

const HANDLERS: Handlers = {
  selection: (msg) => {
    selection = msg.items;
    renderSelection();
    if (state === 'working' || state === 'done') return;
    applyState(exportable().length === 0 ? 'no-selection' : 'idle');
  },
  'export-begin': (msg) => {
    fileTotal = msg.total;
    fileDone = 0;
    applyState('working');
    renderProgress(0, 0);
  },
  svg: (msg) => transformFile(msg),
  'export-end': () => finishExport(),
  error: (msg) => {
    if (msg.nodeId === null) {
      fatal = msg.message;
      showError(msg.message, null);
    } else {
      nodeErrors.push(msg.message);
    }
  },
};

let queue: Promise<void> = Promise.resolve();

function enqueue(msg: CodeToUi): void {
  queue = queue
    .then(() => (HANDLERS[msg.type] as (m: CodeToUi) => Promise<void> | void)(msg))
    .catch((error: unknown) => {
      crash(String(error));
    });
}

// ----------------------------------------------------------------------- wire

qualityInput.addEventListener('input', () => {
  qualityValue.textContent = qualityInput.value;
});

exportButton.addEventListener('click', () => {
  revokeAll(blobUrls.values());
  blobUrls = new Map();
  files = [];
  seenNames = new Set();
  nodeErrors = [];
  fatal = null;
  fileTotal = 0;
  fileDone = 0;
  resultsRoot.textContent = '';
  applyState('working');
  renderProgress(0, 0);
  post({ type: 'export-request', settings: readExportSettings() });
});

window.addEventListener('beforeunload', () => {
  revokeAll(blobUrls.values());
});

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { pluginMessage?: CodeToUi } | null;
  const msg = data?.pluginMessage;
  if (msg && typeof msg.type === 'string' && msg.type in HANDLERS) enqueue(msg);
});

window.onerror = (message, _source, _lineno, _colno, error): void => {
  crash(String(error ?? message));
};

window.onunhandledrejection = (event: PromiseRejectionEvent): void => {
  crash(String(event.reason));
};

qualityValue.textContent = qualityInput.value;
for (const key of Object.keys(EXPORT_SETTING_INPUT) as (keyof SvgExportSettings)[]) {
  EXPORT_SETTING_INPUT[key].checked = DEFAULT_SVG_EXPORT[key];
}
renderSelection();
applyState('loading');
post({ type: 'ui-ready' });
