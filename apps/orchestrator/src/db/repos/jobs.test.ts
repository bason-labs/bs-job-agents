import { researchCompanyFixture } from "@bs-job-agents/shared/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, type Db } from "../client.js";
import { NOVAPAY, T0, at } from "../test-helpers.js";
import { InvalidTransitionError, NotFoundError } from "../errors.js";
import { ensureCompany, findCompanyByName, getCompany, getFreshCompanyProfile, saveCompanyProfile } from "./companies.js";
import {
  clearJobInjection,
  dedupeCandidates,
  flagJobInjection,
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
  source: "topcv",
  url: "https://www.topcv.vn/viec-lam/lap-trinh-vien-frontend-reactjs/2400001.html?ta_source=JobSearchList",
  title: "Lập trình viên Frontend ReactJS",
  company: "Công ty TNHH Sao Việt Tech",
  location: "TP. Hồ Chí Minh",
  salaryText: "25–35 triệu",
  language: "vi",
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

  it("stores work mode and the company website from the candidate", () => {
    const { job } = upsertJobCandidate(db, { ...NOVAPAY, companyWebsite: "https://novapay.vn" });
    expect(job.workMode).toBe("hybrid");
    expect(getCompany(db, job.companyId)?.website).toBe("https://novapay.vn");
  });

  it("stores an uploaded JD whose posting was not found (url null, §7.3b) and dedupes it by hash", () => {
    const fileJd: JobCandidateInput = { ...SAO_VIET, source: "file", url: null };
    const first = upsertJobCandidate(db, fileJd);
    expect(first.created).toBe(true);
    expect(first.job).toMatchObject({ url: null, canonicalUrl: null });
    const other = upsertJobCandidate(db, { ...fileJd, title: "Senior Frontend Engineer" });
    expect(other.created).toBe(true);
    const again = upsertJobCandidate(db, fileJd);
    expect(again).toMatchObject({ created: false, matchedBy: "dedupe_hash" });
    expect(again.job.id).toBe(first.job.id);
    // The posting found later still matches by company + title + location.
    expect(findDuplicateJob(db, SAO_VIET)?.job.id).toBe(first.job.id);
  });

  it("returns the existing job for the same canonical URL", () => {
    const first = upsertJobCandidate(db, NOVAPAY).job;
    const again = upsertJobCandidate(db, { ...NOVAPAY, url: NOVAPAY.url!.replace("utm_source=feed", "utm_source=mail") });
    expect(again).toMatchObject({ created: false, matchedBy: "canonical_url" });
    expect(again.job.id).toBe(first.id);
  });

  it("returns the existing job for the same company + title + location on another source", () => {
    const first = upsertJobCandidate(db, SAO_VIET).job;
    const cross = upsertJobCandidate(db, {
      ...SAO_VIET,
      source: "itviec",
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
    // A job already scored by an earlier run (PM S3: only jobs left `new` are offered again).
    setJobStatus(db, upsertJobCandidate(db, NOVAPAY).job.id, "below_threshold");
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

  it("flags a suspected injection and records Ba's confirmation (UC-07 b)", () => {
    const { job } = upsertJobCandidate(db, NOVAPAY);
    expect(job).toMatchObject({ injectionFlagged: false, injectionClearedAt: null });
    expect(() => clearJobInjection(db, job.id)).toThrow(InvalidTransitionError);
    expect(flagJobInjection(db, job.id)).toMatchObject({ injectionFlagged: true, injectionClearedAt: null });
    expect(clearJobInjection(db, job.id, { now: at(3) })).toMatchObject({ injectionFlagged: true, injectionClearedAt: at(3).toISOString() });
    // A later flag on the same posting keeps Ba's confirmation.
    expect(flagJobInjection(db, job.id).injectionClearedAt).toBe(at(3).toISOString());
    expect(() => flagJobInjection(db, 999)).toThrow(NotFoundError);
    expect(() => clearJobInjection(db, 999)).toThrow(NotFoundError);
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
    saveCompanyProfile(db, c.id, { profile: researchCompanyFixture.company }, { now: T0 });
    expect(getFreshCompanyProfile(db, c.id, { now: new Date(T0.getTime() + 29 * 86_400_000) })?.profile).toEqual(
      researchCompanyFixture.company,
    );
    expect(getFreshCompanyProfile(db, c.id, { now: new Date(T0.getTime() + 31 * 86_400_000) })).toBeUndefined();
  });

  it("takes confidence and website from the profile; the cache clock is the orchestrator's", () => {
    const c = ensureCompany(db, { name: "Tiny Co" });
    const profile = { ...researchCompanyFixture.company, name: "Tiny Co", website: "https://tiny.example", sources: [], confidence: "low_confidence" as const };
    const saved = saveCompanyProfile(db, c.id, { profile }, { now: at(5) });
    expect(saved).toMatchObject({ confidence: "low_confidence", website: "https://tiny.example", researchedAt: at(5).toISOString() });
  });
});
