import { describe, expect, it } from "vitest";
import { applyMention, mentionOptions, mentionQuery, roomMentions, splitMentions } from "./mentions";

const MEMBERS = [
  { name: "lead", displayName: "Lead" },
  { name: "research", displayName: "Research" },
  { name: "cv", displayName: "CV" },
  { name: "qa", displayName: "QA" },
  { name: "apply", displayName: "Apply" },
];

describe("mentionQuery: the @word being typed at the caret", () => {
  it("finds an @ at the start or after a space", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hi @Re", 6)).toEqual({ start: 3, query: "Re" });
    expect(mentionQuery("@CV @q", 6)).toEqual({ start: 4, query: "q" });
  });

  it("ignores emails and a caret away from the word", () => {
    expect(mentionQuery("ba@cv", 5)).toBeNull();
    expect(mentionQuery("hi @Re there", 12)).toBeNull();
    expect(mentionQuery("no mention", 4)).toBeNull();
  });
});

describe("mentionOptions", () => {
  it("lists the members whose name starts with the query", () => {
    expect(mentionOptions("", MEMBERS).map((m) => m.displayName)).toEqual(["Lead", "Research", "CV", "QA", "Apply"]);
    expect(mentionOptions("r", MEMBERS).map((m) => m.displayName)).toEqual(["Research"]);
    expect(mentionOptions("A", MEMBERS).map((m) => m.displayName)).toEqual(["Apply"]);
    expect(mentionOptions("x", MEMBERS)).toEqual([]);
  });
});

describe("applyMention", () => {
  it("replaces the typed word with the bot's name and a space, moving the caret after it", () => {
    expect(applyMention("hi @Re", { start: 3, query: "Re" }, 6, "Research")).toEqual({ text: "hi @Research ", caret: 13 });
    expect(applyMention("@c how?", { start: 0, query: "c" }, 2, "CV")).toEqual({ text: "@CV how?", caret: 4 });
  });
});

describe("roomMentions (shared parseMentions)", () => {
  it("returns the mentioned members, in order, without duplicates", () => {
    expect(roomMentions("@CV @QA how should I present the AI lab work? @cv", MEMBERS)).toEqual(["cv", "qa"]);
    expect(roomMentions("no bot here, mail ba@cv.com", MEMBERS)).toEqual([]);
  });
});

describe("splitMentions", () => {
  it("splits text so mentions of members can be highlighted", () => {
    expect(splitMentions("@CV and @Nobody, ask @QA", MEMBERS)).toEqual([
      { text: "@CV", mention: true },
      { text: " and @Nobody, ask ", mention: false },
      { text: "@QA", mention: true },
    ]);
  });
});
