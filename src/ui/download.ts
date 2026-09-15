const NAME_RULES: ReadonlyArray<[RegExp, string]> = [
  [/[\x00-\x1f\x7f]/g, ''], // control chars
  [/[\\/]/g, '-'], // path separators
  [/[:*?"<>|]/g, '-'], // reserved on Windows, awkward everywhere
  [/\s+/g, ' '], // collapse whitespace incl. newlines in node names
  [/^[\s.]+|[\s.]+$/g, ''], // no leading/trailing dots or spaces
];
const NAME_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const NAME_FALLBACK = 'untitled';
const NAME_MAX = 120; // leaves room for ' (12).svg' inside a 255-byte name

const TRIM_RE = /^[\s.]+|[\s.]+$/g;

export function sanitizeName(raw: string): string {
  let name = String(raw);
  for (const [rule, replacement] of NAME_RULES) name = name.replace(rule, replacement);
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(TRIM_RE, '');
  if (name.length === 0) return NAME_FALLBACK;
  return NAME_RESERVED.test(name) ? '_' + name : name;
}

/** Receives a name that already ends in '.svg'; the counter goes before the extension.
 *  The key is lower-cased (case-insensitive filesystems); the returned name keeps its case. */
export function uniqueName(name: string, seen: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; seen.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  seen.add(candidate.toLowerCase());
  return candidate;
}

// ------------------------------------------------------------------ delivery

export const DOWNLOAD_GAP_MS = 250;
export const SVG_MIME = 'image/svg+xml;charset=utf-8';

export interface DownloadEntry {
  name: string;
  url: string;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createBlobUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: SVG_MIME }));
}

export function triggerDownload(name: string, url: string): void {
  const anchor = document.createElement('a');
  anchor.download = name;
  anchor.href = url;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** A tight loop is silently capped at 10 downloads; the gap is what delivers all of them. */
export async function downloadSequenced(entries: ReadonlyArray<DownloadEntry>): Promise<void> {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    triggerDownload(entry.name, entry.url);
    if (i < entries.length - 1) await sleep(DOWNLOAD_GAP_MS);
  }
}

export function revokeAll(urls: Iterable<string>): void {
  for (const url of urls) URL.revokeObjectURL(url);
}
