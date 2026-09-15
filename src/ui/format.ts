/** Decimal units, matching what Finder shows for the downloaded file. */
const UNITS: ReadonlyArray<[string, number]> = [
  ['GB', 1e9],
  ['MB', 1e6],
  ['KB', 1e3],
  ['B', 1],
];

const MINUS = '−';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  for (const [unit, factor] of UNITS) {
    if (n < factor && factor !== 1) continue;
    const value = n / factor;
    return `${value < 10 && factor !== 1 ? value.toFixed(1) : Math.round(value)} ${unit}`;
  }
  return `${Math.round(n)} B`;
}

export function formatDelta(before: number, after: number): string {
  if (!Number.isFinite(before) || before <= 0) return '0%';
  const percent = Math.round(((after - before) / before) * 100);
  if (percent < 0) return `${MINUS}${-percent}%`;
  return percent > 0 ? `+${percent}%` : '0%';
}
