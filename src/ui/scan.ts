import type { ImageHit } from './types';

/** Source kept separate so each caller builds a fresh regex; a shared /g object carries lastIndex.
 *  Flags 'gd' — the `d` flag gives m.indices.groups.uri, so no offset arithmetic is needed. */
export const DATA_IMAGE_HREF_SOURCE =
  '(?<![-\\w])(?<attr>(?:xlink:)?href)\\s*=\\s*(?<q>["\'])' +
  '(?<uri>data:image\\/(?<subtype>[A-Za-z0-9.+-]+)(?:;[A-Za-z0-9.+=-]+)*?;base64,' +
  '(?<payload>[^"\'<>]*))\\k<q>';

export const makeHrefRe = (): RegExp => new RegExp(DATA_IMAGE_HREF_SOURCE, 'gd');

/** Positive table: an unknown mime falls through to the safe action. */
export const RECODABLE: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/jpg']);
export const recodable = (mime: string): boolean => RECODABLE.has(mime.toLowerCase());

export const TAG_NAME_RE = /^<\s*([A-Za-z_][\w.:-]*)/; // not global — safe as a constant
export const makeAttrRe = (): RegExp => /([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^"']*)\2/g;
export const makeTagSizeRe = (): RegExp =>
  /(?:^|[\s"'\/])(width|height)\s*=\s*(["'])\s*(\+?\d*\.?\d+)\s*(?:px)?\s*\2/g;

/** `lib: es2020` has no RegExpIndicesArray; the shape the 'd' flag adds is declared locally. */
interface MatchWithIndices {
  indices?: { groups?: Record<string, [number, number] | undefined> };
}

export function scanImages(svg: string): ImageHit[] {
  const hits: ImageHit[] = [];
  for (const m of svg.matchAll(makeHrefRe())) {
    const groups = m.groups;
    const uri = (m as unknown as MatchWithIndices).indices?.groups?.['uri'];
    if (!groups || !uri) continue;
    const attr = groups['attr'];
    const quote = groups['q'];
    const subtype = groups['subtype'];
    const payload = groups['payload'];
    if (attr === undefined || quote === undefined) continue;
    if (subtype === undefined || payload === undefined) continue;
    hits.push({
      index: hits.length,
      attr: attr === 'xlink:href' ? 'xlink:href' : 'href',
      quote: quote === "'" ? "'" : '"',
      mime: 'image/' + subtype,
      uriStart: uri[0],
      uriEnd: uri[1],
      payloadRaw: payload,
    });
  }
  return hits;
}

/** Attribute name -> value for one opening tag's text. */
export function readAttributes(tagText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagText.matchAll(makeAttrRe())) {
    const name = m[1];
    const value = m[3];
    if (name !== undefined && value !== undefined) out[name] = value;
  }
  return out;
}

/** A finite number, or null. A value that is not purely numeric is never guessed at. */
export function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface EnclosingTag {
  tagName: string | null;
  elementId: string | null;
  name: string | null;
  boxWidth: number | null;
  boxHeight: number | null;
}

const NO_TAG: EnclosingTag = {
  tagName: null,
  elementId: null,
  name: null,
  boxWidth: null,
  boxHeight: null,
};

/** The opening tag around a hit, parsed with the multi-megabyte uri region cut out. */
export function describeEnclosingTag(svg: string, hit: ImageHit): EnclosingTag {
  const start = svg.lastIndexOf('<', hit.uriStart);
  const end = svg.indexOf('>', hit.uriEnd);
  if (start < 0 || end < 0) return NO_TAG;
  const tagText = svg.slice(start, hit.uriStart) + svg.slice(hit.uriEnd, end + 1);

  const attrs = readAttributes(tagText);
  let boxWidth: number | null = null;
  let boxHeight: number | null = null;
  for (const m of tagText.matchAll(makeTagSizeRe())) {
    if (m[1] === 'width') boxWidth = num(m[3]);
    else boxHeight = num(m[3]);
  }
  return {
    tagName: tagText.match(TAG_NAME_RE)?.[1] ?? null,
    elementId: attrs['id'] ?? null,
    name: attrs['data-name'] ?? null,
    boxWidth,
    boxHeight,
  };
}
