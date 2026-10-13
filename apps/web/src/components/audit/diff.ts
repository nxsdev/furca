export interface DiffLine {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, sortKeys(v)]),
        )
      : value;

/** Pretty JSON with sorted keys, so a diff shows real changes rather than key order. Non-JSON is kept as-is */
export const prettyLines = (json: string | null): Array<string> => {
  if (json === null) return [];
  try {
    return JSON.stringify(sortKeys(JSON.parse(json)), null, 2).split("\n");
  } catch {
    return json.split("\n");
  }
};

/**
 * Line diff via a longest-common-subsequence table.
 * ponytail: O(n·m) memory and time; fine for entity snapshots (hundreds of lines). Switch to Myers if they reach thousands
 */
export function diffLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<DiffLine> {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const out: Array<DiffLine> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) out.push({ kind: "del", text: a[i++] as string });
    else out.push({ kind: "add", text: b[j++] as string });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] as string });
  while (j < m) out.push({ kind: "add", text: b[j++] as string });
  return out;
}

export type DiffRow = DiffLine | { readonly kind: "skip"; readonly count: number };

/** Keeps `context` unchanged lines around each change and folds longer unchanged runs */
export function foldUnchanged(lines: ReadonlyArray<DiffLine>, context = 3): Array<DiffRow> {
  const out: Array<DiffRow> = [];
  let run: Array<DiffLine> = [];
  const flush = (atStart: boolean, atEnd: boolean) => {
    const head = atStart ? 0 : context;
    const tail = atEnd ? 0 : context;
    if (run.length > head + tail + 1) {
      out.push(...run.slice(0, head), { kind: "skip", count: run.length - head - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    run = [];
  };
  let seenChange = false;
  for (const line of lines) {
    if (line.kind === "same") run.push(line);
    else {
      flush(!seenChange, false);
      seenChange = true;
      out.push(line);
    }
  }
  flush(!seenChange, true);
  return out;
}
