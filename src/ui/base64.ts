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
  const bin = atob(clean); // one binary string, no argument-list limit
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
