// CSRF for state-changing requests (PM S18). The single place the client side of the scheme lives:
// the orchestrator refuses any POST/PUT/PATCH/DELETE without the shared CSRF header (a form cannot
// set it, and a cross-origin fetch would need a CORS preflight the API never answers). Browser
// requests reach the API through the web app's own origin (the /api rewrite in next.config.ts).
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@bs-job-agents/shared";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Headers to add to a request with this method. */
export function csrfHeaders(method: string): Record<string, string> {
  return SAFE_METHODS.has(method.toUpperCase()) ? {} : { [CSRF_HEADER]: CSRF_HEADER_VALUE };
}
