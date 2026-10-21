// Live 2026-10-20: the review preview showed the contact line in the name's place and no name.
import { describe, expect, it } from "vitest";
import { previewHeader } from "./CvPreview";

const live = { headline: "Frontend Developer / React, Redux & TypeScript", contactLine: "HCMC, Vietnam | huynhthienba4@gmail.com | +84 37 247 4489 | linkedin.com/in/bahuynh" };

describe("previewHeader", () => {
  it("the name from the master CV, then the headline, then one contact line (as the PDF prints it)", () => {
    expect(previewHeader(live, "Ba Huynh")).toEqual({ name: "Ba Huynh", headline: live.headline, contact: live.contactLine });
  });

  it("never takes the name from the contact line; without a name there is no title", () => {
    expect(previewHeader(live, null).name).toBeNull();
    expect(previewHeader(live, undefined).name).toBeNull();
  });

  it("a contact line that starts with the name does not repeat it", () => {
    expect(previewHeader({ headline: "H", contactLine: "Ba Huynh · huynhthienba4@gmail.com · +84 37 247 4489" }, "Ba Huynh").contact).toBe("huynhthienba4@gmail.com · +84 37 247 4489");
  });
});
