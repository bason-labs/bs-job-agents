import type { Metadata } from "next";
import { CriteriaLive } from "@/components/criteria/CriteriaScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Search criteria" };

/** UC-21b: the active Search Profile (centered, max-w-3xl as in the prototype), plus UC-12 saved answers. Live data. */
export default function CriteriaPage() {
  return (
    <Page width="narrow">
      <CriteriaLive />
    </Page>
  );
}
