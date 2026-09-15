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
