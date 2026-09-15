// src/code.ts — the sandbox half. See DESIGN.md §3.1.
// Reads the selection, exports SVG, relays messages. It never writes to the document.

import {
  ERROR_TEXT,
  type CodeToUi,
  type ErrorCode,
  type SelectionItem,
  type SvgExportSettings,
  type UiToCode,
} from './protocol';

const UI_SIZE = { width: 400, height: 560, themeColors: true, title: 'SVG Smash' } as const;

/** The panel's switch rides on `export-request`; the format never varies. */
// Ids are always on: with them off, exportAsync drops <g> wrappers that only carry a blend mode.
const exportSettings = (settings: SvgExportSettings): ExportSettingsSVGString => ({
  format: 'SVG_STRING',
  svgIdAttribute: true,
  ...settings,
});

const yieldToHost = () => new Promise<void>((r) => setTimeout(r, 0));

/** figma.notify truncates at 100 characters (DESIGN.md §8). */
const NOTIFY_MAX = 100;

/** Nothing is sent before the iframe announces itself; pre-load queueing is not relied on. */
let uiReady = false;

function describeSelection(): SelectionItem[] {
  return figma.currentPage.selection.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    exportable: 'exportAsync' in node,
  }));
}

function post(msg: CodeToUi): void {
  figma.ui.postMessage(msg);
}

function postError(code: ErrorCode, nodeId: string | null): void {
  post({ type: 'error', code, message: ERROR_TEXT[code], nodeId });
}

function postSelection(): void {
  post({ type: 'selection', items: describeSelection() });
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function doneText(msg: Extract<UiToCode, { type: 'ui-done' }>): string {
  const saved =
    msg.originalBytes > 0
      ? ` — ${Math.round((1 - msg.newBytes / msg.originalBytes) * 100)}% smaller`
      : '';
  const kept = msg.failed > 0 ? `, ${plural(msg.failed, 'image')} kept as is` : '';
  return `Exported ${plural(msg.files, 'file')}${saved}${kept}.`.slice(0, NOTIFY_MAX);
}

async function runExport(settings: SvgExportSettings): Promise<void> {
  const exportOptions = exportSettings(settings);
  const selection = figma.currentPage.selection;
  const nodes = selection.filter((node): node is SceneNode & ExportMixin => 'exportAsync' in node);
  const total = nodes.length;

  if (total === 0) {
    postError(selection.length === 0 ? 'no-selection' : 'nothing-exportable', null);
    post({ type: 'export-end', total: 0, exported: 0, failed: 0 });
    return;
  }

  post({ type: 'export-begin', total });
  let exported = 0;
  let failed = 0;

  for (let index = 0; index < total; index++) {
    const node = nodes[index]!;
    try {
      const svg = await node.exportAsync(exportOptions);
      post({ type: 'svg', index, total, nodeId: node.id, nodeName: node.name, svg });
      exported++;
    } catch {
      postError('export-failed', node.id);
      failed++;
    }
    await yieldToHost();
  }

  post({ type: 'export-end', total, exported, failed });
}

const HANDLERS: { [K in UiToCode['type']]: (msg: Extract<UiToCode, { type: K }>) => void } = {
  'ui-ready': () => {
    uiReady = true;
    postSelection();
  },
  'export-request': (msg) => {
    void runExport(msg.settings);
  },
  'ui-done': (msg) => {
    figma.notify(doneText(msg));
  },
  'ui-error': (msg) => {
    figma.notify(msg.message, { error: true });
  },
  close: () => {
    figma.closePlugin();
  },
};

function isUiToCode(msg: unknown): msg is UiToCode {
  if (typeof msg !== 'object' || msg === null) return false;
  const type: unknown = (msg as { type?: unknown }).type;
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, type);
}

figma.showUI(__html__, UI_SIZE);

figma.ui.onmessage = (msg: unknown): void => {
  if (!isUiToCode(msg)) return;
  // The table is keyed by `type`; TS cannot correlate the lookup with the narrowed message.
  (HANDLERS[msg.type] as (m: UiToCode) => void)(msg);
};

figma.on('selectionchange', () => {
  if (uiReady) postSelection();
});
