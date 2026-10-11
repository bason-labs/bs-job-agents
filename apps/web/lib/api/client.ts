// The low-level typed client for screens whose calls are not on WebApi yet (W3c's data.ts modules:
// applications, criteria, schedules, bots, master CV, saved answers, rooms). Any API_ROUTES entry:
//
//   const http = browserClient();
//   const { applications } = await http.request("GET", API_ROUTES.applications, { schema: ApplicationsResponseSchema });
//   await http.request("POST", API_ROUTES.applicationStatus, { params: { id }, body: { status, note } });
//   await http.request("POST", API_ROUTES.uploads, { form, schema: UploadsResponseSchema });
//
// Same behaviour as WebApi: same-origin /api base, the CSRF header on mutations, JSON bodies,
// shared-schema validation, ApiRequestError on failure. Server components use serverClient().
import { BROWSER_API_BASE, orchestratorUrl } from "./config";
import { createHttpClient, type HttpClient } from "./http";

export type { HttpClient };
export { apiPath } from "./routes";

let browser: HttpClient | null = null;

/** For client components (through the /api proxy, proxy.ts). */
export function browserClient(): HttpClient {
  browser ??= createHttpClient({ baseUrl: BROWSER_API_BASE });
  return browser;
}

/** For server components (straight to the orchestrator on 127.0.0.1). */
export function serverClient(): HttpClient {
  return createHttpClient({ baseUrl: orchestratorUrl() });
}
