// Keyboard navigation helpers for list-style widgets (Select, menus).

export interface NavItem {
  label: string;
  disabled?: boolean;
}

/** Next enabled index from `from` in direction `dir`, wrapping. -1 if none. */
export function moveIndex(items: readonly NavItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}

/**
 * Type-ahead: the first enabled item after `from` (wrapping) whose label starts
 * with `query`. A query of one repeated letter ("ttt") cycles like "t".
 */
export function typeaheadIndex(items: readonly NavItem[], query: string, from: number): number {
  const n = items.length;
  if (n === 0 || query === "") return -1;
  let q = query.toLowerCase();
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  if (repeated) q = q[0]!;
  // A fresh single-letter search starts after the current item; a longer query
  // may still match the current item.
  const startOffset = q.length === 1 ? 1 : 0;
  for (let step = 0; step < n; step++) {
    const i = (from + startOffset + step) % n;
    const item = items[i]!;
    if (!item.disabled && item.label.toLowerCase().startsWith(q)) return i;
  }
  return -1;
}
