// Data access for the Master CV screen (UC-20, §6.1).
//
// Screens import `masterCvData` from here and nothing else, so wiring the real API is a
// one-line change: replace the fixture implementation below with an adapter over lib/api
// (W3b's typed client). Shapes are the shared schemas.
//   GET /master-cv → MasterCvSchema, mapped to a read state: 404 → missing,
//                    409 { reason: "master_cv_invalid" } → invalid (the message is the detail)
//   PUT /master-cv → body MasterCvUpdateRequestSchema (with the version it was loaded at); the
//                    server bumps the version, or answers 409 { reason: "master_cv_changed",
//                    currentVersion } when the file changed since (another tab, a hand edit)
// Additive API needs (handoff): GET /master-cv/versions (version history), and the open
// fact requests CV raised (§6.1) with a way to answer "No, I don't".
import { MasterCvUpdateRequestSchema, type MasterCv } from "@bs-job-agents/shared";
import { cvOutputFixture } from "@bs-job-agents/shared/fixtures";
import { FixtureApiError } from "@/components/schedules/apiError";
import { MASTER_CV } from "./fixtures";

export type MasterCvRead = { state: "ok"; cv: MasterCv } | { state: "missing" } | { state: "invalid"; detail: string };

export interface MasterCvVersion {
  version: number;
  savedAt: string;
  factCount: number;
}

/** A fact CV asked about while tailoring a CV (CvOutput.factRequests). */
export interface FactRequestItem {
  id: string;
  jobId: string;
  company: string;
  topic: string;
  question: string;
  reason: string;
}

export interface MasterCvData {
  get(): Promise<MasterCvRead>;
  /** Saves the facts; the result carries the bumped version (UC-20). Rejects a stale version. */
  save(cv: MasterCv): Promise<MasterCv>;
  /** Newest first. */
  versions(): Promise<MasterCvVersion[]>;
  factRequests(): Promise<FactRequestItem[]>;
  /** "No, I don't": CV continues without the fact (it never invents one). */
  dismissFactRequest(id: string): Promise<void>;
}

/** In-memory stand-in seeded from the fixtures (no orchestrator needed). */
export function createFixtureMasterCvData(
  opts: { seed?: MasterCv | null; invalid?: string; now?: () => Date } = {},
): MasterCvData {
  const now = opts.now ?? (() => new Date());
  let cv: MasterCv | null = opts.seed === undefined ? structuredClone(MASTER_CV) : opts.seed && structuredClone(opts.seed);
  const invalid = opts.invalid ?? null;
  const history: MasterCvVersion[] = cv
    ? [
        { version: 5, savedAt: "2026-10-08T22:05:00+07:00", factCount: 5 },
        { version: 6, savedAt: "2026-10-09T21:40:00+07:00", factCount: 6 },
        { version: cv.version, savedAt: "2026-10-10T09:00:00+07:00", factCount: cv.facts.length },
      ].filter((v) => v.version <= cv!.version)
    : [];
  let requests: FactRequestItem[] = cvOutputFixture.factRequests.map((r, i) => ({
    id: `fr_${i + 1}`,
    jobId: "job_1",
    company: "NovaPay",
    topic: r.topic,
    question: r.question,
    reason: r.reason,
  }));

  return {
    async get() {
      if (invalid) return { state: "invalid", detail: invalid };
      return cv ? { state: "ok", cv: structuredClone(cv) } : { state: "missing" };
    },
    async save(next) {
      const parsed = MasterCvUpdateRequestSchema.parse(next);
      if (cv && parsed.version !== cv.version) {
        throw new FixtureApiError(409, "conflict", `the master CV changed since you opened it (now version ${cv.version}); reload it first`, {
          reason: "master_cv_changed",
          currentVersion: cv.version,
        });
      }
      cv = { ...parsed, version: cv ? cv.version + 1 : 1 };
      history.push({ version: cv.version, savedAt: now().toISOString(), factCount: cv.facts.length });
      // A request is answered once a fact mentions its topic.
      const facts = cv.facts;
      const mentions = (topic: string) => facts.some((f) => [f.text, ...f.tags].some((t) => t.toLowerCase().includes(topic.toLowerCase())));
      requests = requests.filter((r) => !mentions(r.topic));
      return structuredClone(cv);
    },
    async versions() {
      return [...history].reverse().map((v) => ({ ...v }));
    },
    async factRequests() {
      return requests.map((r) => ({ ...r }));
    },
    async dismissFactRequest(id) {
      requests = requests.filter((r) => r.id !== id);
    },
  };
}

export const masterCvData: MasterCvData = createFixtureMasterCvData();
