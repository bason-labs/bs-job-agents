/** Optional clock override accepted by repository functions (tests pass a fixed time). */
export interface ClockOpts {
  now?: Date;
}

export function nowIso(opts?: ClockOpts): string {
  return (opts?.now ?? new Date()).toISOString();
}

export function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
