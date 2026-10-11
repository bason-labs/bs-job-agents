// Orchestrator route paths. API_ROUTES (shared) is the contract W3a implements; the two
// routes below are what the UI also needs and are not in API_ROUTES yet (W3b → W3a handoff).

/** Routes the UI calls that API_ROUTES does not list yet. W3a: add them, or tell W3b the real paths. */
export const PROPOSED_ROUTES = {
  /** POST ChoiceRequest (shared ChoiceRequestSchema): a chip on a `choice` card (UC-21b a). */
  chatChoice: "/chat/choices",
  /** GET → { lines: TranscriptLine[] }: a task's transcript for the step drawer (UC-22). */
  taskTranscript: "/tasks/:id/transcript",
  /**
   * POST {}: UC-11 e "Don't allow" on a domain_confirm pause (engine.declineDomain, F3). The API route
   * lands in Phase 3 QA; until then the orchestrator answers 404 and the UI says so.
   */
  taskDeclineDomain: "/tasks/:id/decline-domain",
} as const;

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
