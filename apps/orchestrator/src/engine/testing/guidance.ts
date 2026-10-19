// CV guidance test helpers: a fake guidance fetcher (no network: every page is answered from a map,
// unchanged by default) and a master CV with facts the default fake CV can cite truthfully.
import { createHash } from "node:crypto";
import { classifySource, guidanceContentKey, registrableHost, type MasterCvInput } from "@bs-job-agents/shared";
import { cvOutputFixture, masterCvFixture } from "@bs-job-agents/shared/fixtures";
import { stringify } from "yaml";
import type { GuidanceFetchPort, GuidanceFetchRequest, GuidanceFetchResult } from "../ports.js";
import type { FakeMasterCv, MemoryFileStore } from "./fakes.js";

export class FakeGuidanceFetch implements GuidanceFetchPort {
  /** Every URL asked for, in order (the "mocked network"). */
  readonly requests: GuidanceFetchRequest[] = [];
  readonly pages = new Map<string, GuidanceFetchResult>();
  /** Every page fails (all sources unreachable). */
  unreachable = false;
  /** Holds every fetch until released (a refresh in progress). */
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  async fetchPages(requests: readonly GuidanceFetchRequest[]): Promise<GuidanceFetchResult[]> {
    if (this.gate) await this.gate;
    return requests.map((r) => {
      this.requests.push(r);
      if (this.unreachable) return { url: r.url, status: "failed", reason: "getaddrinfo ENOTFOUND" };
      return this.pages.get(r.url) ?? { url: r.url, status: "not_modified" };
    });
  }

  /** A page that answers with `text` (changed, or new when it is not a source yet). */
  serve(url: string, text: string, title = "CV guide"): void {
    const host = registrableHost(url) ?? new URL(url).hostname;
    this.pages.set(url, { url, status: "ok", finalUrl: url, title, text, contentHash: createHash("sha256").update(guidanceContentKey(text)).digest("hex"), etag: null, lastModified: null, host, ...classifySource(host, text) });
  }
}

/** Facts that back every bullet, dates line and skill of the default fake CV (cvOutputFixture). */
export function truthfulMaster(over: Partial<MasterCvInput> = {}): MasterCvInput {
  const t = cvOutputFixture.tailored;
  const text = [t.summary?.text ?? "", ...t.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.map((b) => b.text)))].join(" ");
  const ids = new Set([...(t.summary?.factIds ?? []), ...t.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.flatMap((b) => b.factIds)))]);
  return {
    ...masterCvFixture,
    version: 3,
    facts: [...ids].map((id) => ({ id, type: "experience" as const, text, textVi: null, tags: [], org: "Gradion", dates: "2022 – Present" })),
    ...over,
  };
}

export function writeMaster(files: MemoryFileStore, master: FakeMasterCv, cv: MasterCvInput): void {
  files.write(master.path, stringify(cv, { lineWidth: 0 }));
  master.current = cv.version ?? 3;
}
