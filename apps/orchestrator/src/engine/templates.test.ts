import { describe, expect, it } from "vitest";
import { resolveList, resolveTemplate, type TemplateScope } from "./templates.js";

const scope: TemplateScope = {
  params: { sources: ["topcv", "itviec"], url: "https://itviec.com/j/1", applyAgain: true },
  profile: { fitThreshold: 60, maxJobs: 5 },
  item: { jobId: 7, company: "NovaPay", companyWebsite: null },
  steps: (key) =>
    ({
      scan: { jobs: [{ title: "Senior FE" }] },
      dedupe: { items: [{ jobId: 7 }, { jobId: 8 }], duplicates: 2 },
    })[key],
  producer: { language: "en" },
  branch: "7",
};

describe("workflow templates (§7.1 inputs and options)", () => {
  it("resolves $params, $profile, $item, $steps.<key>.output, $producer and $branch", () => {
    expect(resolveTemplate("$params.sources", scope)).toEqual(["topcv", "itviec"]);
    expect(resolveTemplate("$profile.fitThreshold", scope)).toBe(60);
    expect(resolveTemplate("$item", scope)).toEqual(scope.item);
    expect(resolveTemplate("$item.company", scope)).toBe("NovaPay");
    expect(resolveTemplate("$item.companyWebsite", scope)).toBeNull();
    expect(resolveTemplate("$steps.scan.output.jobs", scope)).toEqual([{ title: "Senior FE" }]);
    expect(resolveTemplate("$producer.output.language", scope)).toBe("en");
    expect(resolveTemplate("$branch", scope)).toBe("7");
  });

  it("resolves inside objects and arrays and leaves literals alone", () => {
    expect(resolveTemplate({ threshold: "$profile.fitThreshold", take: "$profile.maxJobs", mode: "strict", n: 3, list: ["$branch"] }, scope)).toEqual({
      threshold: 60,
      take: 5,
      mode: "strict",
      n: 3,
      list: ["7"],
    });
  });

  it("unknown references resolve to undefined, never throw", () => {
    expect(resolveTemplate("$params.nope.deeper", scope)).toBeUndefined();
    expect(resolveTemplate("$steps.missing.output", scope)).toBeUndefined();
    expect(resolveTemplate("$unknown", scope)).toBeUndefined();
  });

  it("a map's `over` takes a list, or the items of a filter's output", () => {
    expect(resolveList("$params.sources", scope)).toEqual(["topcv", "itviec"]);
    expect(resolveList("$steps.dedupe.output", scope)).toEqual([{ jobId: 7 }, { jobId: 8 }]);
    expect(resolveList("$profile.maxJobs", scope)).toBeNull();
  });
});
