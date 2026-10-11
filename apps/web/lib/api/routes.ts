// Orchestrator route paths: the shared API_ROUTES is the whole contract (every route the UI calls
// is in it; lib/api/parity.test.ts checks); apiPath fills a template.

export type QueryValue = string | number | boolean | null | undefined;

/** `/review/:jobId/approve` + { jobId } → `/review/job_1/approve`, plus an optional query string. */
export function apiPath(template: string, params: Record<string, string> = {}, query: Record<string, QueryValue> = {}): string {
  const path = template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`apiPath(${template}): missing path param "${name}"`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}
