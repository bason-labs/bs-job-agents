// Data access for the Master CV screen (UC-20, §6.1).
//
// Screens import `masterCvData` from here and nothing else, so wiring the real API is a
// one-line change: replace the fixture implementation below with an adapter over lib/api
// (W3b's typed client). Shapes are the shared schemas.
//   GET /master-cv   → MasterCvSchema
//   PUT /master-cv   → body MasterCvUpdateRequestSchema; the server bumps the version
// Additive API needs (handoff): GET /master-cv/versions (version history), and the open
// fact requests CV raised (§6.1) with a way to answer "No, I don't".
import { MasterCvUpdateRequestSchema, type MasterCv } from "@bs-job-agents/shared";
import { cvOutputFixture } from "@bs-job-agents/shared/fixtures";
import { MASTER_CV } from "./fixtures";

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
  get(): Promise<MasterCv>;
  /** Saves the facts; the result carries the bumped version (UC-20). */
  save(cv: MasterCv): Promise<MasterCv>;
  /** Newest first. */
  versions(): Promise<MasterCvVersion[]>;
  factRequests(): Promise<FactRequestItem[]>;
  /** "No, I don't": CV continues without the fact (it never invents one). */
  dismissFactRequest(id: string): Promise<void>;
}

/** In-memory stand-in seeded from the fixtures (no orchestrator needed). */
export function createFixtureMasterCvData(seed: MasterCv = MASTER_CV, now: () => Date = () => new Date()): MasterCvData {
  let cv = structuredClone(seed);
  const history: MasterCvVersion[] = [
    { version: 5, savedAt: "2026-10-08T22:05:00+07:00", factCount: 5 },
    { version: 6, savedAt: "2026-10-09T21:40:00+07:00", factCount: 6 },
    { version: cv.version, savedAt: "2026-10-10T09:00:00+07:00", factCount: cv.facts.length },
  ].filter((v) => v.version <= cv.version);
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
      return structuredClone(cv);
    },
    async save(next) {
      const parsed = MasterCvUpdateRequestSchema.parse(next);
      cv = { ...parsed, version: cv.version + 1 };
      history.push({ version: cv.version, savedAt: now().toISOString(), factCount: cv.facts.length });
      // A request is answered once a fact mentions its topic.
      const mentions = (topic: string) => cv.facts.some((f) => [f.text, ...f.tags].some((t) => t.toLowerCase().includes(topic.toLowerCase())));
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
