// W5: the search sources' metadata, the find-only rule and the time-zone overlap field.
import { describe, expect, it } from "vitest";
import { SEARCH_PROFILE_DEFAULTS, SearchProfileFieldsSchema } from "../domain/search-profile.js";
import { SearchSourceSchema } from "./primitives.js";
import {
  FEED_SOURCES,
  FIND_ONLY_SOURCES,
  SEARCH_SOURCES,
  anyRemoteSource,
  findOnlySourceOf,
  isFeedSource,
  sourceLabel,
  sourcesInGroup,
} from "./sources.js";
import { parseTimezoneOverlap } from "./timezone.js";

describe("SEARCH_SOURCES", () => {
  it("adds the new sources after the original three; the defaults stay TopCV, ITviec, LinkedIn", () => {
    expect(SearchSourceSchema.options).toEqual(["topcv", "itviec", "linkedin", "vietnamworks", "remoteok", "weworkremotely", "remotive", "jobspresso", "wellfound", "upwork"]);
    expect(SEARCH_PROFILE_DEFAULTS.sources).toEqual(["topcv", "itviec", "linkedin"]);
  });

  it("feeds are fetched by the orchestrator; the rest are read in Chrome", () => {
    expect(FEED_SOURCES).toEqual(["remoteok", "weworkremotely", "remotive", "jobspresso"]);
    expect(isFeedSource("remoteok")).toBe(true);
    expect(isFeedSource("wellfound")).toBe(false);
    expect(isFeedSource("career_site")).toBe(false);
  });

  it("groups the toggles: Vietnam boards, Remote boards, Global", () => {
    expect(sourcesInGroup("vietnam")).toEqual(["topcv", "itviec", "vietnamworks"]);
    expect(sourcesInGroup("remote")).toEqual(["remoteok", "weworkremotely", "remotive", "jobspresso"]);
    expect(sourcesInGroup("global")).toEqual(["linkedin", "wellfound", "upwork"]);
  });

  it("remote boards: the four feeds plus Wellfound and Upwork", () => {
    const remote = SearchSourceSchema.options.filter((s) => SEARCH_SOURCES[s].remote);
    expect(remote).toEqual(["remoteok", "weworkremotely", "remotive", "jobspresso", "wellfound", "upwork"]);
    expect(anyRemoteSource(["topcv", "linkedin"])).toBe(false);
    expect(anyRemoteSource(["topcv", "upwork"])).toBe(true);
  });

  it("labels", () => {
    expect(sourceLabel("weworkremotely")).toBe("We Work Remotely");
    expect(sourceLabel("career_site")).toBe("career_site");
  });
});

describe("find only (Upwork)", () => {
  it("Upwork is the only source the app never applies on", () => {
    expect(FIND_ONLY_SOURCES).toEqual(["upwork"]);
    expect(SEARCH_SOURCES.upwork.canApply).toBe(false);
  });

  it("by the job's source, or by its URL for a pasted link", () => {
    expect(findOnlySourceOf({ source: "upwork", url: "https://www.upwork.com/jobs/~021234567890123456" })).toBe("upwork");
    expect(findOnlySourceOf({ source: "link", url: "https://www.upwork.com/freelance-jobs/apply/React-dev_~021234567890123456/" })).toBe("upwork");
    expect(findOnlySourceOf({ source: "link", url: "https://upwork.com.evil.example/jobs/x" })).toBeNull();
    expect(findOnlySourceOf({ source: "remoteok", url: "https://remoteok.com/remote-jobs/x-1" })).toBeNull();
    expect(findOnlySourceOf({ source: "file", url: null })).toBeNull();
  });
});

describe("timezoneOverlap", () => {
  it.each([
    ["Asia", { from: 5, to: 9 }],
    ["apac", { from: 5, to: 12 }],
    ["Asia ±2h", { from: 3, to: 11 }],
    ["UTC+7 ±3h", { from: 4, to: 10 }],
    ["UTC+7 +/- 3 hours", { from: 4, to: 10 }],
    ["GMT+07:00", { from: 5, to: 9 }],
    ["UTC+7", { from: 5, to: 9 }],
    ["UTC-5 ±1", { from: -6, to: -4 }],
    ["UTC", { from: -2, to: 2 }],
  ])("%s → %o", (text, range) => {
    expect(parseTimezoneOverlap(text)).toEqual(range);
  });

  it.each(["", "Mars", "UTC+20", "UTC+7 ±30h", "7pm"])("%j is not a time-zone overlap", (text) => {
    expect(parseTimezoneOverlap(text)).toBeNull();
  });

  it("is optional and nullable on the profile, and validated when given", () => {
    const base = { ...SEARCH_PROFILE_DEFAULTS, roles: ["Frontend Engineer"], locations: ["Remote"] };
    expect(SearchProfileFieldsSchema.safeParse(base).success).toBe(true);
    expect(SearchProfileFieldsSchema.safeParse({ ...base, timezoneOverlap: null }).success).toBe(true);
    expect(SearchProfileFieldsSchema.safeParse({ ...base, timezoneOverlap: "UTC+7 ±3h" }).success).toBe(true);
    const bad = SearchProfileFieldsSchema.safeParse({ ...base, timezoneOverlap: "somewhere" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(["timezoneOverlap"]);
  });
});
