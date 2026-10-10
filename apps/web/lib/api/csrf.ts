// CSRF for state-changing requests (PM S18). W3a defines the server side; this file is the
// single place to adjust the client side. Today it sends:
// - `x-requested-with: bs-job-agents` on every non-GET request (a custom header forces a CORS
//   preflight, which the orchestrator refuses for foreign origins), and
// - the value of the `bsja_csrf` cookie, if the orchestrator set one, in `x-csrf-token`
//   (double-submit cookie). Browser requests reach the orchestrator through the same-origin
//   proxy (/api/orch), so the cookie is scoped to the web app's origin.

export const CSRF_COOKIE = "bsja_csrf";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const documentCookies = () => (typeof document === "undefined" ? "" : document.cookie);

export function readCookie(cookies: string, name: string): string | null {
  for (const part of cookies.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Headers to add to a request with this method. */
export function csrfHeaders(method: string, cookies: () => string = documentCookies): Record<string, string> {
  if (SAFE_METHODS.has(method.toUpperCase())) return {};
  const token = readCookie(cookies(), CSRF_COOKIE);
  return { "x-requested-with": "bs-job-agents", ...(token ? { [CSRF_HEADER]: token } : {}) };
}
