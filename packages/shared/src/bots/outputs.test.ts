import { describe, expect, it } from "vitest";
import {
  applyOutputFixture,
  applyPausedFixture,
  consultHandoffFixture,
  cvOutputFixture,
  leadOutputFixture,
  qaFailFixture,
  qaPassFixture,
  researchCompanyFixture,
  researchFitFixture,
  researchScanFixture,
  validBotOutputFixtures,
} from "../fixtures/bot-outputs.js";
import { checkStrictJsonSchema } from "../json-schema/check.js";
import { findOptionalPaths } from "../json-schema/strict.js";
import { validateJsonSchemaSubset } from "../json-schema/validate.js";
import { ApplyOutputSchema, needsBaAnswer } from "./apply.js";
import { ConsultOutputSchema } from "./consult.js";
import { CvOutputSchema } from "./cv.js";
import { LeadOutputSchema } from "./lead.js";
import { QaOutputSchema, qaPassed } from "./qa.js";
import {
  BOT_OUTPUT_SCHEMAS,
  BOT_OUTPUT_SCHEMA_NAMES,
  getBotOutputJsonSchema,
  getBotOutputSchema,
  parseBotOutput,
} from "./registry.js";
import {
  ResearchCompanyOutputSchema,
  ResearchFitOutputSchema,
  ResearchScanOutputSchema,
} from "./research.js";
import { SelfCheckItemSchema, failedSelfChecks } from "./self-check.js";

const clone = <T>(v: T): T => structuredClone(v);

describe("bot output registry", () => {
  it("registers every output schema by name", () => {
    expect([...BOT_OUTPUT_SCHEMA_NAMES].sort()).toEqual(
      [
        "ApplyOutput",
        "ConsultOutput",
        "CvOutput",
        "CvReviewOutput",
        "DeriveOutput",
        "FactDraftOutput",
        "GuidanceDiscoverOutput",
        "GuidanceExtractOutput",
        "LeadOutput",
        "QaOutput",
        "ResearchCompanyOutput",
        "ResearchFitOutput",
        "ResearchRepairOutput",
        "ResearchScanOutput",
      ].sort(),
    );
    expect(getBotOutputSchema("QaOutput")).toBe(QaOutputSchema);
  });

  it("has at least one valid fixture per schema", () => {
    for (const name of BOT_OUTPUT_SCHEMA_NAMES) {
      expect(validBotOutputFixtures[name].length, name).toBeGreaterThan(0);
    }
  });

  describe.each(BOT_OUTPUT_SCHEMA_NAMES)("%s", (name) => {
    const schema = BOT_OUTPUT_SCHEMAS[name];
    const json = getBotOutputJsonSchema(name);

    it("generates a strict JSON Schema (additionalProperties:false, required == keys, no $ref)", () => {
      expect(checkStrictJsonSchema(json)).toEqual([]);
      expect(JSON.stringify(json)).not.toContain("$ref");
      expect(json.title).toBe(name);
    });

    it("uses nullable, never optional/default, so model nulls parse", () => {
      expect(findOptionalPaths(schema)).toEqual([]);
    });

    it("requires selfCheck and memoryNotes (rule 4, §5.4)", () => {
      expect(json.required).toEqual(expect.arrayContaining(["selfCheck", "memoryNotes"]));
    });

    it("lets the engine enforce ≥ 1 self-check item and ≤ 3 memory notes (live-verified keywords)", () => {
      const props = json.properties as Record<string, Record<string, unknown>>;
      expect(props.selfCheck).toMatchObject({ type: "array", minItems: 1 });
      expect(props.memoryNotes).toMatchObject({ type: "array", maxItems: 3 });
    });

    it("never emits pattern (an unbounded pattern hung Codex in the live check)", () => {
      expect(JSON.stringify(json)).not.toContain('"pattern"');
    });

    it("accepts its valid fixtures under both Zod and the generated JSON Schema", () => {
      for (const fixture of validBotOutputFixtures[name]) {
        const parsed = schema.safeParse(fixture);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(validateJsonSchemaSubset(json, fixture)).toEqual([]);
      }
    });

    it("rejects unknown and missing keys", () => {
      const fixture = clone(validBotOutputFixtures[name][0]) as Record<string, unknown>;
      expect(schema.safeParse({ ...fixture, extra: 1 }).success).toBe(false);
      const { selfCheck: _drop, ...missing } = fixture;
      expect(schema.safeParse(missing).success).toBe(false);
    });

    it("caches the generated JSON Schema", () => {
      expect(getBotOutputJsonSchema(name)).toBe(json);
    });
  });

  it("carries score ranges and datetime formats into the JSON Schema", () => {
    const qa = getBotOutputJsonSchema("QaOutput") as { properties: Record<string, { properties?: Record<string, unknown> } & Record<string, unknown>> };
    expect(qa.properties.total).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    const jdMatch = qa.properties.scores.properties?.jdMatch as { properties: Record<string, unknown> };
    expect(jdMatch.properties.score).toMatchObject({ type: "integer", minimum: 0, maximum: 40 });
    const company = getBotOutputJsonSchema("ResearchCompanyOutput") as {
      properties: { company: { properties: Record<string, unknown> } };
    };
    expect(company.properties.company.properties.researchedAt).toMatchObject({ type: "string", format: "date-time" });
  });

  it("describes the Figma frame name format, since the pattern stays out of the JSON Schema", () => {
    const cv = getBotOutputJsonSchema("CvOutput") as { properties: Record<string, { description?: string }> };
    expect(cv.properties.figmaFrameName?.description).toMatch(/<COMPANY>_<ROLE>_<LANG>_v<n>/);
    expect(cv.properties.figmaFrameName?.description).toMatch(/EN or VI/);
  });

  it("parseBotOutput returns typed data or the zod issues", () => {
    const ok = parseBotOutput("QaOutput", qaPassFixture);
    expect(ok.success).toBe(true);
    const bad = parseBotOutput("QaOutput", { nope: true });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.length).toBeGreaterThan(0);
  });
});

describe("self-check", () => {
  it("item requires note as nullable string", () => {
    expect(SelfCheckItemSchema.safeParse({ item: "x", passed: true, note: null }).success).toBe(true);
    expect(SelfCheckItemSchema.safeParse({ item: "x", passed: true }).success).toBe(false);
  });

  it("failedSelfChecks lists failed items", () => {
    expect(
      failedSelfChecks([
        { item: "a", passed: true, note: null },
        { item: "b", passed: false, note: "broken" },
      ]),
    ).toEqual([{ item: "b", passed: false, note: "broken" }]);
  });

  it("caps memoryNotes at 3 (§5.4)", () => {
    const v = clone(qaPassFixture);
    v.memoryNotes = ["1", "2", "3", "4"];
    expect(QaOutputSchema.safeParse(v).success).toBe(false);
  });

  it("requires at least one self-check item", () => {
    const v = clone(qaPassFixture);
    v.selfCheck = [];
    expect(QaOutputSchema.safeParse(v).success).toBe(false);
  });
});

describe("LeadOutput", () => {
  it("rejects an unknown action type", () => {
    const v = clone(leadOutputFixture) as { actions: unknown[] };
    v.actions.push({ type: "browse", url: "https://x.y" });
    expect(LeadOutputSchema.safeParse(v).success).toBe(false);
  });

  it("a start_workflow names a shipped workflow or a saved preset (PM3 S4); anything but a slug is refused", () => {
    const v = clone(leadOutputFixture) as { actions: Array<Record<string, unknown>> };
    v.actions[0] = { ...v.actions[0], workflow: "danang-react" };
    expect(LeadOutputSchema.safeParse(v).success).toBe(true);
    for (const bad of ["Hack The Planet!", "../job-scan", ""]) {
      v.actions[0] = { ...v.actions[0], workflow: bad };
      expect(LeadOutputSchema.safeParse(v).success, bad).toBe(false);
    }
  });
});

describe("Research outputs", () => {
  it("scan: rejects a candidate with a snippet-sized JD or bad URL", () => {
    const v = clone(researchScanFixture);
    v.jobs[0]!.url = "not a url";
    expect(ResearchScanOutputSchema.safeParse(v).success).toBe(false);
    const w = clone(researchScanFixture);
    w.jobs[0]!.jdText = "";
    expect(ResearchScanOutputSchema.safeParse(w).success).toBe(false);
  });

  it("scan: zero results is a valid empty list (UC-03 d)", () => {
    const v = clone(researchScanFixture);
    v.jobs = [];
    expect(ResearchScanOutputSchema.safeParse(v).success).toBe(true);
  });

  it("scan: a file JD may have no apply URL (§7.3b)", () => {
    const v = clone(researchScanFixture);
    v.jobs[0]!.url = null;
    expect(ResearchScanOutputSchema.safeParse(v).success).toBe(true);
  });

  it("fit: score must be an integer 0–100", () => {
    for (const score of [-1, 101, 50.5]) {
      const v = clone(researchFitFixture);
      v.fit.score = score;
      expect(ResearchFitOutputSchema.safeParse(v).success, String(score)).toBe(false);
    }
  });

  it("company: a normal-confidence profile needs ≥ 2 sources; low_confidence allows fewer", () => {
    const v = clone(researchCompanyFixture);
    v.company.sources = v.company.sources.slice(0, 1);
    expect(ResearchCompanyOutputSchema.safeParse(v).success).toBe(false);
    v.company.confidence = "low_confidence";
    expect(ResearchCompanyOutputSchema.safeParse(v).success).toBe(true);
  });
});

describe("CvOutput", () => {
  it("rejects a bullet without factIds (§10.2 rule 3)", () => {
    const v = clone(cvOutputFixture);
    v.tailored.sections[0]!.items[0]!.bullets[0]!.factIds = [];
    expect(CvOutputSchema.safeParse(v).success).toBe(false);
  });

  it("rejects an unknown language and a disallowed font", () => {
    const a = clone(cvOutputFixture) as Record<string, unknown>;
    a.language = "fr";
    expect(CvOutputSchema.safeParse(a).success).toBe(false);
    const b = clone(cvOutputFixture);
    (b.tailored.layout as { font: string }).font = "Comic Sans";
    expect(CvOutputSchema.safeParse(b).success).toBe(false);
  });

  it("carries factRequests for missing facts (§6.1, UC-06 c)", () => {
    expect(cvOutputFixture.factRequests.length).toBeGreaterThan(0);
  });
});

describe("QaOutput", () => {
  it("rejects a total that is not the sum of the scores", () => {
    const v = clone(qaPassFixture);
    v.total = v.total + 1;
    expect(QaOutputSchema.safeParse(v).success).toBe(false);
  });

  it("rejects sub-scores above their maximum", () => {
    const v = clone(qaPassFixture);
    v.scores.jdMatch.score = 41;
    v.total = 41 + v.scores.companyTone.score + v.scores.formatAts.score + v.scores.clarity.score;
    expect(QaOutputSchema.safeParse(v).success).toBe(false);
  });

  it("qaPassed: total ≥ 80 and no hard fails", () => {
    expect(qaPassed(qaPassFixture)).toBe(true);
    expect(qaPassed(qaFailFixture)).toBe(false);
    const v = clone(qaPassFixture);
    v.hardFails = [{ code: "wrong_language", detail: "EN CV for VI target", section: null }];
    expect(qaPassed(v)).toBe(false);
  });

  it("rejects an unknown hard-fail code", () => {
    const v = clone(qaFailFixture) as { hardFails: Array<Record<string, unknown>> };
    v.hardFails[0]!.code = "too_pretty";
    expect(QaOutputSchema.safeParse(v).success).toBe(false);
  });
});

describe("ApplyOutput", () => {
  it("accepts every field source including form_defaults and skipped", () => {
    const sources = applyOutputFixture.fieldsFilled.map((f) => f.source);
    expect(sources).toEqual(expect.arrayContaining(["master_cv", "search_profile", "form_defaults", "skipped"]));
  });

  it("rejects an unknown field source", () => {
    const v = clone(applyOutputFixture) as { fieldsFilled: Array<Record<string, unknown>> };
    v.fieldsFilled[0]!.source = "guessed";
    expect(ApplyOutputSchema.safeParse(v).success).toBe(false);
  });

  it("a skipped field must be optional and blank (§5.2 Apply)", () => {
    const v = clone(applyOutputFixture);
    const skipped = v.fieldsFilled.find((f) => f.source === "skipped")!;
    skipped.required = true;
    expect(ApplyOutputSchema.safeParse(v).success).toBe(false);
    skipped.required = false;
    skipped.value = "something";
    expect(ApplyOutputSchema.safeParse(v).success).toBe(false);
  });

  it("submitted requires an uploaded file with a SHA-256 and confirmation evidence", () => {
    const a = clone(applyOutputFixture);
    a.uploadedFile = null;
    expect(ApplyOutputSchema.safeParse(a).success).toBe(false);
    const b = clone(applyOutputFixture);
    b.uploadedFile!.sha256 = "abc";
    expect(ApplyOutputSchema.safeParse(b).success).toBe(false);
    const c = clone(applyOutputFixture);
    c.confirmationText = null;
    c.confirmationScreenshot = null;
    expect(ApplyOutputSchema.safeParse(c).success).toBe(false);
  });

  it("paused requires a reason or pending questions", () => {
    const v = clone(applyPausedFixture);
    v.pendingQuestions = [];
    v.pauseReason = null;
    expect(ApplyOutputSchema.safeParse(v).success).toBe(false);
  });

  it("pending questions carry required/optional flags (UC-12)", () => {
    const qs = applyPausedFixture.pendingQuestions;
    expect(qs.some((q) => q.required)).toBe(true);
    expect(needsBaAnswer(applyPausedFixture)).toBe(true);
    expect(needsBaAnswer(applyOutputFixture)).toBe(false);
  });
});

describe("ConsultOutput", () => {
  it("allows a handoff to Lead (UC-25 a)", () => {
    expect(ConsultOutputSchema.parse(consultHandoffFixture).handoffToLead?.request).toMatch(/find/i);
  });
});
