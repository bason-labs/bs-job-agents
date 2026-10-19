// AD-2: the shared HTTP layer of the non-browser paths (feeds and board APIs).
export { HostGate, MIN_HOST_GAP_MS, sleepFor, type HostGateOptions } from "./gate.js";
export { HttpRequestError, classifyStatus, sendRequest, sendRequestNoRedirect, type HttpAnswer, type HttpFailureKind, type HttpFetch, type HttpResponse, type SendRequest } from "./request.js";
