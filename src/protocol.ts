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

/** Figma's own default is the opposite; see DESIGN.md §8 for why this one wins. */
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
