export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Collect-then-splice: sorts, asserts non-overlap, one pass. */
export function spliceAll(src: string, edits: Edit[]): string {
  const ordered = edits.slice().sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor || edit.end < edit.start) {
      throw new Error(`overlapping edit at ${edit.start}..${edit.end}`);
    }
    parts.push(src.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(src.slice(cursor));
  return parts.join('');
}
