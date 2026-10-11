// Server components' view of the API (the (shell) layout, route params, metadata). Resolved per
// request: the orchestrator over HTTP, or a read-only mock with the same seed the browser's mock
// starts from (the browser's mock keeps its own state; the server one is never changed).
import { orchestratorUrl, resolveApiMode } from "./config";
import type { ApiMode, EventFeed, WebApi } from "./contract";
import { createHttpApi } from "./http";

const NO_EVENTS: EventFeed = { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} };

let serverMock: Promise<WebApi> | null = null;

function getServerMock(): Promise<WebApi> {
  serverMock ??= import("./mock/backend").then(({ MockBackend }) => new MockBackend());
  return serverMock;
}

export async function getServerApi(mode?: ApiMode): Promise<WebApi> {
  const resolved = mode ?? (await resolveApiMode());
  if (resolved === "mock") return getServerMock();
  return createHttpApi({ baseUrl: orchestratorUrl(), events: NO_EVENTS });
}
