export type WordChange = { text: string; changed: boolean };

// Keep whitespace, punctuation and Unicode intact. Compare only the changed middle;
// cap the LCS table so large/minified replacements cannot exhaust the renderer.
export function wordDiff(before: string, after: string): [WordChange[], WordChange[]] {
  const tokens = (text: string) => text.match(/[\p{L}\p{N}\p{M}_]+|[^\S\n]+|\n|[^\p{L}\p{N}\p{M}_\s]/gu) ?? [];
  const a = tokens(before), b = tokens(after);
  const deleted = a.map(() => true), added = b.map(() => true);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) {
    deleted[start] = added[start] = false; start++;
  }
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    deleted[--endA] = added[--endB] = false;
  }
  const rows = endA - start + 1, columns = endB - start + 1;
  if (rows > 1 && columns > 1 && rows * columns <= 250_000) {
    const lengths = new Uint32Array(rows * columns);
    for (let i = rows - 2; i >= 0; i--) for (let j = columns - 2; j >= 0; j--) {
      lengths[i * columns + j] = a[start + i] === b[start + j]
        ? 1 + lengths[(i + 1) * columns + j + 1]
        : Math.max(lengths[(i + 1) * columns + j], lengths[i * columns + j + 1]);
    }
    let i = 0, j = 0;
    while (i < rows - 1 && j < columns - 1) {
      if (a[start + i] === b[start + j]) { deleted[start + i++] = false; added[start + j++] = false; }
      else if (lengths[(i + 1) * columns + j] >= lengths[i * columns + j + 1]) i++;
      else j++;
    }
  }
  const chunks = (parts: string[], changed: boolean[]): WordChange[] => {
    const result: WordChange[] = [];
    parts.forEach((text, i) => {
      const last = result.at(-1);
      if (last?.changed === changed[i]) last.text += text;
      else result.push({ text, changed: changed[i] });
    });
    return result;
  };
  return [chunks(a, deleted), chunks(b, added)];
}
