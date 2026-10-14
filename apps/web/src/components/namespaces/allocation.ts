/** Namespace slices are [start, end) fractions of 0..1 */
export interface Slice {
  readonly start: number;
  readonly end: number;
}

export const overlaps = (a: Slice, b: Slice) => a.start < b.end && b.start < a.end;

/** Rounds to 0.1% so percent inputs never produce float noise like 0.30000000000000004 */
export const roundSlice = (x: number) => Math.round(x * 1000) / 1000;

/** Uncovered ranges of [0, 1), in order */
export const freeRanges = (taken: ReadonlyArray<Slice>): Array<Slice> => {
  const out: Array<Slice> = [];
  let cursor = 0;
  for (const s of [...taken].sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) out.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < 1) out.push({ start: cursor, end: 1 });
  return out.filter((r) => r.end - r.start >= 0.001);
};

/** The first free range that fits `width` (trimmed to it), else the first free range; null when full */
export const firstFreeSlice = (taken: ReadonlyArray<Slice>, width: number): Slice | null => {
  const free = freeRanges(taken);
  const fit = free.find((r) => r.end - r.start >= width - 1e-9);
  if (fit !== undefined) return { start: roundSlice(fit.start), end: roundSlice(fit.start + width) };
  const first = free[0];
  return first === undefined ? null : { start: roundSlice(first.start), end: roundSlice(first.end) };
};

/** Share of the namespace no draft or running experiment holds */
export const freeShare = (taken: ReadonlyArray<Slice>) => freeRanges(taken).reduce((sum, r) => sum + r.end - r.start, 0);
