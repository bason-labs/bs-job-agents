// The Next.js RSC payload reader (2026-10-20 addendum): VietnamWorks job pages carry the job in
// self.__next_f.push chunks, with text rows measured in UTF-8 bytes and "$<hex>" references.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findFlightRef, flightObject, flightRows, flightText, resolveFlight } from "./rsc.js";

const push = (s: string) => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`;
const text = (id: string, t: string) => `${id}:T${Buffer.byteLength(t, "utf8").toString(16)},${t}`;

describe("flightText", () => {
  it("joins every push([1, string]) in order; other pushes and other scripts are ignored", () => {
    const html = `<script>self.__next_f.push([0])</script>${push("a:1\n")}<script>self.__next_f.push([2,null])</script><script>var x = 1;</script>${push("b:2\n")}`;
    expect(flightText(html)).toBe("a:1\nb:2\n");
    expect(flightText("<html></html>")).toBe("");
  });

  it("reads the escaped '<\\/' a page writes inside a script", () => {
    expect(flightText('<script>self.__next_f.push([1,"a:\\"<p>x<\\/p>\\"\\n"])</script>')).toBe('a:"<p>x</p>"\n');
  });
});

describe("flightRows", () => {
  it("text rows are measured in UTF-8 bytes (Vietnamese text), JSON rows end at a newline", () => {
    const vi = "<p>Mô tả công việc: phát triển hệ thống</p>";
    const rows = flightRows(`1:{"a":"$2"}\n${text("2", vi)}3:["x"]\n`);
    expect(rows.get("1")).toEqual({ kind: "model", raw: '{"a":"$2"}' });
    expect(rows.get("2")).toEqual({ kind: "text", text: vi });
    expect(rows.get("3")).toEqual({ kind: "model", raw: '["x"]' });
  });

  it("a text row may be followed directly by the next row, and junk lines are skipped", () => {
    const rows = flightRows(`junk line\n${text("a", "hello")}b:1\n`);
    expect(rows.get("a")).toEqual({ kind: "text", text: "hello" });
    expect(rows.get("b")).toEqual({ kind: "model", raw: "1" });
  });
});

describe("resolveFlight", () => {
  it("replaces $<hex> refs recursively; $$ is a literal $; $L lazy refs, missing and circular refs stay", () => {
    const rows = flightRows(`1:{"d":"$2","list":"$3","lit":"$$5","lazy":"$L9","gone":"$ff"}\n${text("2", "<b>JD</b>")}3:[{"n":"$4"}]\n4:"deep"\n5:{"self":"$5"}\n`);
    expect(resolveFlight("$1", rows)).toEqual({ d: "<b>JD</b>", list: [{ n: "deep" }], lit: "$5", lazy: "$L9", gone: "$ff" });
    expect(resolveFlight("$5", rows)).toEqual({ self: "$5" });
  });

  it("QA r1 #7: '$<hex>:<key>…' path refs resolve to the value inside the row; a path that leads nowhere stays", () => {
    const rows = flightRows(`1:{"a":"$3:job:title","b":"$3:list:1","c":"$3:nope","d":"$2:x"}\n${text("2", "plain")}3:{"job":{"title":"$4"},"list":["x","y"]}\n4:"Dev"\n`);
    expect(resolveFlight("$1", rows)).toEqual({ a: "Dev", b: "y", c: "$3:nope", d: "$2:x" });
  });

  it("findFlightRef finds the page row's reference", () => {
    const rows = flightRows(`b:["$","$L27",null,{"jobDetail":"$28"}]\n28:{"jobId":1}\n`);
    expect(findFlightRef(rows, "jobDetail")).toBe("28");
    expect(findFlightRef(rows, "other")).toBeNull();
  });
});

describe("flightObject on the captured VietnamWorks job page", () => {
  const html = readFileSync(new URL("../board-api/fixtures/vietnamworks/job-2110333.html", import.meta.url), "utf8");

  it("follows jobDetail to the job row and resolves its text rows and lists", () => {
    const job = flightObject(html, "jobDetail")!;
    expect(job.jobId).toBe(2110333);
    expect(job.jobTitle).toBe("(Middle, Senior) BackEnd Engineer (Java, Spring Boot) - Khối Công nghệ thông tin (2025TD923)");
    expect(String(job.jobDescription)).toMatch(/^<p>MB là ngân hàng/);
    expect(String(job.jobRequirement).length).toBeGreaterThan(300);
    expect(job.workingLocations).toEqual([expect.objectContaining({ cityName: "Ha Noi" })]);
    expect(Array.isArray(job.benefits) && job.benefits.length).toBeGreaterThan(0);
    expect(job.isExpired).toBe(false);
  });

  it("a page without the jobDetail row gives null", () => {
    expect(flightObject("<html><body>nothing</body></html>", "jobDetail")).toBeNull();
    expect(flightObject(push('b:["$","$L27",null,{"other":"$28"}]\n'), "jobDetail")).toBeNull();
  });
});
