import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { NOVAPAY, T0, at } from "../test-helpers.js";
import { NotFoundError } from "../errors.js";
import { ensureCompany, findCompanyByName, getCompany, getFreshCompanyProfile, saveCompanyProfile } from "./companies.js";
import {
  dedupeCandidates,
  findDuplicateJob,
  findJobByUrl,
  getJob,
  listJobs,
  setJobFit,
  setJobStatus,
  skipJob,
  upsertJobCandidate,
  type JobCandidateInput,
} from "./jobs.js";

let db: Db;
beforeEach(() => {
  db = openTestDb();
});

const SAO_VIET: JobCandidateInput = {
  source: "TopCV",
  url: "https://www.topcv.vn/viec-lam/lap-trinh-vien-frontend-reactjs/2400001.html?ta_source=JobSearchList",
  title: "Lập trình viên Frontend ReactJS",
  company: "Công ty TNHH Sao Việt Tech",
  location: "TP. Hồ Chí Minh",
  salaryText: "25–35 triệu",
  language: "VI",
  jdText: "Mô tả công việc…",
};

describe("upsertJobCandidate (UC-03 / UC-04)", () => {
  it("stores a new candidate as a `new` job with dedupe keys and a company stub", () => {
    const { job, created } = upsertJobCandidate(db, NOVAPAY, { now: T0 });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      status: "new",
      title: NOVAPAY.title,
      canonicalUrl: "https://itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234",
      firstSeenAt: T0.toISOString(),
    });
    expect(job.dedupeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(getCompany(db, job.companyId)?.name).toBe("NovaPay");
  });

  it("returns the existing job for the same canonical URL", () => {
    const first = upsertJobCandidate(db, NOVAPAY).job;
    const again = upsertJobCandidate(db, { ...NOVAPAY, url: NOVAPAY.url.replace("utm_source=feed", "utm_source=mail") });
    expect(again).toMatchObject({ created: false, matchedBy: "canonical_url" });
    expect(again.job.id).toBe(first.id);
  });

  it("returns the existing job for the same company + title + location on another source", () => {
    const first = upsertJobCandidate(db, SAO_VIET).job;
    const cross = upsertJobCandidate(db, {
      ...SAO_VIET,
      source: "ITviec",
      url: "https://itviec.com/it-jobs/frontend-reactjs-sao-viet-9",
      company: "Sao Viet Tech",
      title: "Lap trinh vien Frontend ReactJS",
      location: "Ho Chi Minh City",
    });
    expect(cross).toMatchObject({ created: false, matchedBy: "dedupe_hash" });
    expect(cross.job.id).toBe(first.id);
  });

  it("enforces unique dedupe keys in SQL too", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY);
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO jobs (source, url, canonical_url, dedupe_hash, title, company_id, status, first_seen_at) VALUES ('x','u',?, 'h','t',?, 'new', 'now')",
        )
        .run(job.canonicalUrl, job.companyId),
    ).toThrow(/UNIQUE/);
  });

  it("findDuplicateJob / findJobByUrl look up without writing", () => {
    expect(findDuplicateJob(db, NOVAPAY)).toBeUndefined();
    const { job } = upsertJobCandidate(db, NOVAPAY);
    expect(findDuplicateJob(db, NOVAPAY)?.job.id).toBe(job.id);
    expect(findJobByUrl(db, "https://www.itviec.com/it-jobs/senior-frontend-engineer-react-nextjs-novapay-1234/")?.id).toBe(job.id);
  });
});

describe("dedupeCandidates (§7.2 step 3)", () => {
  it("returns only new jobs and reports duplicates, including within the batch", () => {
    upsertJobCandidate(db, NOVAPAY);
    const r = dedupeCandidates(db, [NOVAPAY, SAO_VIET, { ...SAO_VIET, url: SAO_VIET.url + "&utm_campaign=z" }]);
    expect(r.fresh.map((j) => j.title)).toEqual([SAO_VIET.title]);
    expect(r.duplicates).toHaveLength(2);
  });

  it("keeps skipped jobs excluded unless includeSkipped (UC-04b)", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY);
    skipJob(db, job.id, { reason: "salary_low" });
    expect(dedupeCandidates(db, [NOVAPAY]).fresh).toHaveLength(0);
    expect(dedupeCandidates(db, [NOVAPAY], { includeSkipped: true }).fresh.map((j) => j.id)).toEqual([job.id]);
  });
});

describe("job updates", () => {
  it("stores fit score, reasons and gaps", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY);
    const fit = setJobFit(db, job.id, { score: 87, reasons: ["React/Next.js"], gaps: ["GraphQL"] });
    expect(fit).toMatchObject({ fitScore: 87, fitReasons: ["React/Next.js"], gaps: ["GraphQL"] });
    expect(() => setJobFit(db, job.id, { score: 101, reasons: [], gaps: [] })).toThrow(/CHECK/);
  });

  it("skips with a reason and clears it when status moves on", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY);
    expect(skipJob(db, job.id, { reason: "other", note: "too far" })).toMatchObject({
      status: "skipped",
      skipReason: "other",
      skipNote: "too far",
    });
    expect(setJobStatus(db, job.id, "selected")).toMatchObject({ status: "selected", skipReason: null });
    expect(() => setJobStatus(db, 999, "selected")).toThrow(NotFoundError);
  });

  it("lists by status", () => {
    const a = upsertJobCandidate(db, NOVAPAY, { now: at(1) }).job;
    const b = upsertJobCandidate(db, SAO_VIET, { now: at(2) }).job;
    setJobStatus(db, a.id, "below_threshold");
    expect(listJobs(db).map((j) => j.id)).toEqual([b.id, a.id]);
    expect(listJobs(db, { status: "new" }).map((j) => j.id)).toEqual([b.id]);
    expect(getJob(db, a.id)?.status).toBe("below_threshold");
  });
});

describe("companies (UC-05)", () => {
  it("ensureCompany reuses rows by normalised name", () => {
    const a = ensureCompany(db, { name: "NovaPay JSC" });
    const b = ensureCompany(db, { name: "novapay", website: "https://novapay.vn" });
    expect(b.id).toBe(a.id);
    expect(b.website).toBe("https://novapay.vn");
    expect(findCompanyByName(db, "NOVAPAY")?.id).toBe(a.id);
  });

  it("reuses a profile younger than 30 days, not older", () => {
    const c = ensureCompany(db, { name: "NovaPay" });
    expect(getFreshCompanyProfile(db, c.id)).toBeUndefined();
    saveCompanyProfile(db, c.id, { profile: { industry: "fintech" }, confidence: "normal" }, { now: T0 });
    expect(getFreshCompanyProfile(db, c.id, { now: new Date(T0.getTime() + 29 * 86_400_000) })?.profile).toEqual({
      industry: "fintech",
    });
    expect(getFreshCompanyProfile(db, c.id, { now: new Date(T0.getTime() + 31 * 86_400_000) })).toBeUndefined();
  });

  it("records low confidence profiles", () => {
    const c = ensureCompany(db, { name: "Tiny Co" });
    expect(saveCompanyProfile(db, c.id, { profile: {}, confidence: "low_confidence" }).confidence).toBe("low_confidence");
  });
});
