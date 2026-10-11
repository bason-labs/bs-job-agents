import { act, render, screen, waitFor } from "@testing-library/react";
import { sampleEvents } from "@bs-job-agents/shared/fixtures";
import { describe, expect, it, vi } from "vitest";
import type { EventListener, WebApi } from "./contract";
import { ApiProvider, lazyMockApi, useAppEvents, useResource } from "./react";

function fakeApi(over: Partial<WebApi> = {}): WebApi & { emit: (i: number) => void } {
  const listeners = new Set<EventListener>();
  return {
    mode: "live",
    events: { subscribe: (l) => (listeners.add(l), () => listeners.delete(l)), getStatus: () => "open", onStatus: () => () => {} },
    emit: (i: number) => listeners.forEach((l) => l(sampleEvents[i]!)),
    ...over,
  } as WebApi & { emit: (i: number) => void };
}

describe("useResource", () => {
  it("loads, caches per key and api, re-reads on demand and de-duplicates", async () => {
    let n = 0;
    const loader = vi.fn(async () => `v${++n}`);
    const api = fakeApi();
    let reload: () => Promise<void> = async () => {};
    function Probe({ id }: { id: string }) {
      const r = useResource("thing", loader);
      reload = r.reload;
      return <p data-testid={id}>{r.loading && r.data === undefined ? "loading" : String(r.data)}</p>;
    }
    render(
      <ApiProvider mode="live" api={api}>
        <Probe id="a" />
        <Probe id="b" />
      </ApiProvider>,
    );
    // Two mounts share one cache entry and one request in flight (the second re-reads once after it).
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("a")).toHaveTextContent("v2"));
    expect(screen.getByTestId("b")).toHaveTextContent("v2");
    const calls = loader.mock.calls.length;
    await act(() => reload());
    await waitFor(() => expect(loader.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.getByTestId("a")).toHaveTextContent(`v${n}`));
  });

  it("keeps the last data while an error is shown, and mutate patches without a request", async () => {
    let fail = false;
    const api = fakeApi();
    let r!: ReturnType<typeof useResource<number[]>>;
    function Probe() {
      r = useResource("list", async () => {
        if (fail) throw new Error("down");
        return [1, 2];
      });
      return <p data-testid="p">{JSON.stringify(r.data)} {r.error ? "error" : ""}</p>;
    }
    render(
      <ApiProvider mode="live" api={api}>
        <Probe />
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("p")).toHaveTextContent("[1,2]"));
    fail = true;
    await act(() => r.reload());
    expect(screen.getByTestId("p")).toHaveTextContent("[1,2] error");
    act(() => r.mutate((prev) => [...(prev ?? []), 3]));
    expect(screen.getByTestId("p")).toHaveTextContent("[1,2,3]");
  });

  it("a null key loads nothing", () => {
    const loader = vi.fn(async () => 1);
    function Probe() {
      useResource(null, loader);
      return null;
    }
    render(
      <ApiProvider mode="live" api={fakeApi()}>
        <Probe />
      </ApiProvider>,
    );
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("useAppEvents", () => {
  it("delivers feed events to the latest handler until unmount", () => {
    const api = fakeApi();
    const seen: string[] = [];
    function Probe() {
      useAppEvents((e) => seen.push(e.type));
      return null;
    }
    const { unmount } = render(
      <ApiProvider mode="live" api={api}>
        <Probe />
      </ApiProvider>,
    );
    act(() => api.emit(0));
    unmount();
    act(() => api.emit(1));
    expect(seen).toEqual([sampleEvents[0]!.type]);
  });
});

describe("lazyMockApi", () => {
  it("answers through the mock once loaded and forwards its events", async () => {
    const api = lazyMockApi(1000);
    const seen: string[] = [];
    api.events.subscribe((e) => seen.push(e.type));
    expect(api.mode).toBe("mock");
    expect((await api.getReviewQueue()).map((c) => c.job.company)).toEqual(["NovaPay", "Sao Việt Tech", "Kite Labs"]);
    await api.controlRun("12", "pause");
    expect(seen).toContain("run.updated");
    expect(api.fileUrl("pdf-2102")).toBe("/dev/sample-cv.pdf");
  });
});
