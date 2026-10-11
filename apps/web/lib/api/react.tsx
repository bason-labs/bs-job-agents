"use client";

// The data seam for client components: one WebApi per tab (live: HTTP through /api/orch + SSE;
// mock: the in-memory backend, loaded lazily so production bundles do not carry it), plus hooks:
// - useApi / useApiMode
// - useAppEvents(handler): every live AppEvent
// - useFeedStatus(): SSE connection state
// - useResource(key, load): a cached read that screens refresh on events (stale-while-revalidate)
import { API_ROUTES, type AppEvent } from "@bs-job-agents/shared";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BROWSER_API_BASE } from "./config";
import type { ApiMode, EventFeed, EventListener, FeedStatus, WebApi } from "./contract";
import { createHttpApi } from "./http";
import type { MockBackend } from "./mock/backend";
import { createLiveEventFeed } from "./sse";

// ---------------------------------------------------------------- the client api

type AsyncMethod = Exclude<keyof WebApi, "mode" | "events" | "fileUrl" | "apiUrl">;
/** Every async WebApi method (the type makes a missing or extra name a compile error). */
const ASYNC_METHODS: Record<AsyncMethod, true> = {
  getHealth: true,
  getShellData: true,
  getBot: true,
  getRoom: true,
  listBots: true,
  listEngines: true,
  listRooms: true,
  listMessages: true,
  sendMessage: true,
  uploadFiles: true,
  answerQuestion: true,
  resumeTask: true,
  declineDomain: true,
  chooseOption: true,
  listRuns: true,
  getRun: true,
  getStep: true,
  controlRun: true,
  rerunStep: true,
  getTranscript: true,
  getReviewQueue: true,
  approve: true,
  requestChanges: true,
  skip: true,
  confirmInjection: true,
  request: true,
};

export type LazyMockApi = WebApi & { ready: Promise<MockBackend> };

/** Forwards to the mock once its chunk has loaded (the first render needs a WebApi right away). */
export function lazyMockApi(speed: number): LazyMockApi {
  const listeners = new Set<EventListener>();
  let instance: MockBackend | null = null;
  const ready = import("./mock/backend").then(({ MockBackend }) => {
    instance = new MockBackend({ speed });
    instance.subscribe((e) => {
      for (const fn of [...listeners]) fn(e);
    });
    // e2e and the Simulate menu drive the mock through this handle (mock mode only).
    if (typeof window !== "undefined") (window as unknown as { __bsjaMock?: MockBackend }).__bsjaMock = instance;
    return instance;
  });
  const events: EventFeed = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getStatus: (): FeedStatus => "open",
    onStatus: () => () => {},
  };
  const api: Record<string, unknown> = {
    mode: "mock",
    events,
    ready,
    fileUrl: (id: string) => (instance ? instance.fileUrl(id) : "/dev/sample-cv.pdf"),
    apiUrl: (path: string) => path,
  };
  for (const name of Object.keys(ASYNC_METHODS) as AsyncMethod[]) {
    api[name] = async (...args: unknown[]) => {
      const mock = await ready;
      return (mock[name] as (...a: unknown[]) => unknown).apply(mock, args);
    };
  }
  return api as unknown as LazyMockApi;
}

let clientApi: { key: string; api: WebApi } | null = null;

/** During SSR client components only read `mode`; requests and subscriptions start in effects. */
function serverRenderApi(mode: ApiMode): WebApi {
  const idle: EventFeed = { subscribe: () => () => {}, getStatus: () => "idle", onStatus: () => () => {} };
  const api: Record<string, unknown> = { mode, events: idle, fileUrl: () => "#", apiUrl: () => "#" };
  for (const name of Object.keys(ASYNC_METHODS)) api[name] = () => new Promise(() => {});
  return api as unknown as WebApi;
}

/** One api per tab and mode, so the mock's state and the SSE connection survive navigation. */
export function getClientApi(mode: ApiMode, speed = 1): WebApi {
  if (typeof window === "undefined") return serverRenderApi(mode);
  const key = `${mode}:${speed}`;
  if (clientApi?.key === key) return clientApi.api;
  const api =
    mode === "live"
      ? createHttpApi({ baseUrl: BROWSER_API_BASE, events: createLiveEventFeed({ url: `${BROWSER_API_BASE}${API_ROUTES.events}` }) })
      : lazyMockApi(speed);
  clientApi = { key, api };
  return api;
}

const ApiContext = createContext<WebApi | null>(null);

export function ApiProvider({ mode, mockSpeed = 1, api, children }: { mode: ApiMode; mockSpeed?: number; api?: WebApi; children: ReactNode }) {
  const [value] = useState(() => api ?? getClientApi(mode, mockSpeed));
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): WebApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside <ApiProvider> (the (shell) layout provides it)");
  return api;
}

export function useApiMode(): ApiMode {
  return useApi().mode;
}

// ---------------------------------------------------------------- events

/** Calls the latest `handler` for every live event while mounted. */
export function useAppEvents(handler: (event: AppEvent) => void): void {
  const api = useApi();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => api.events.subscribe((e) => ref.current(e)), [api]);
}

export function useFeedStatus(): FeedStatus {
  const api = useApi();
  return useSyncExternalStore(
    (cb) => api.events.onStatus(cb),
    () => api.events.getStatus(),
    () => "idle",
  );
}

// ---------------------------------------------------------------- cached reads

export interface ResourceState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

export interface Resource<T> extends ResourceState<T> {
  /** Re-reads now (events call it, usually through a debounce). */
  reload: () => Promise<void>;
  /** Patches the cached value (e.g. from an event) without a request. */
  mutate: (fn: (prev: T | undefined) => T | undefined) => void;
}

interface Entry {
  state: ResourceState<unknown>;
  inFlight: Promise<void> | null;
  again: boolean;
  listeners: Set<() => void>;
}

const EMPTY: ResourceState<never> = { data: undefined, error: null, loading: false };
const stores = new WeakMap<WebApi, Map<string, Entry>>();

function entryFor(api: WebApi, key: string): Entry {
  let store = stores.get(api);
  if (!store) stores.set(api, (store = new Map()));
  let entry = store.get(key);
  if (!entry) store.set(key, (entry = { state: EMPTY, inFlight: null, again: false, listeners: new Set() }));
  return entry;
}

function setState(entry: Entry, patch: Partial<ResourceState<unknown>>) {
  entry.state = { ...entry.state, ...patch };
  for (const fn of [...entry.listeners]) fn();
}

function load(entry: Entry, run: () => Promise<unknown>): Promise<void> {
  if (entry.inFlight) {
    entry.again = true;
    return entry.inFlight;
  }
  setState(entry, { loading: true });
  entry.inFlight = run()
    .then(
      (data) => setState(entry, { data, error: null, loading: false }),
      (error: unknown) => setState(entry, { error, loading: false }),
    )
    .finally(() => {
      entry.inFlight = null;
      if (entry.again) {
        entry.again = false;
        void load(entry, run);
      }
    });
  return entry.inFlight;
}

/** Drops cached reads (tests). */
export function clearResourceCache(api: WebApi): void {
  stores.delete(api);
}

/**
 * A read keyed by `key` (null = nothing to load yet). Cached per api, so going back to a screen
 * shows the last data at once and re-reads it in the background.
 */
export function useResource<T>(key: string | null, loader: (api: WebApi) => Promise<T>): Resource<T> {
  const api = useApi();
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      const entry = entryFor(api, key);
      entry.listeners.add(cb);
      return () => entry.listeners.delete(cb);
    },
    [api, key],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? entryFor(api, key).state : EMPTY),
    () => EMPTY,
  ) as ResourceState<T>;
  const reload = useCallback(() => (key ? load(entryFor(api, key), () => loaderRef.current(api)) : Promise.resolve()), [api, key]);
  const mutate = useCallback(
    (fn: (prev: T | undefined) => T | undefined) => {
      if (!key) return;
      const entry = entryFor(api, key);
      setState(entry, { data: fn(entry.state.data as T | undefined) });
    },
    [api, key],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  // Back from a dropped connection: re-read, since live events in the gap may be lost (a first
  // SSE connection gets no history, so state always comes from REST).
  useEffect(() => {
    let prev = api.events.getStatus();
    return api.events.onStatus((status) => {
      if (status === "open" && prev === "reconnecting") void reload();
      prev = status;
    });
  }, [api, reload]);
  return { ...state, reload, mutate };
}

/** A callback that runs at most once per `ms` burst (events → one re-read). */
export function useDebounced<A extends unknown[]>(fn: (...args: A) => void, ms = 250): (...args: A) => void {
  const ref = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => ref.current(...args), ms);
    },
    [ms],
  );
}
