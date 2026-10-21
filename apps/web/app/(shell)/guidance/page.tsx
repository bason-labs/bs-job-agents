import type { Metadata } from "next";
import { GuidanceLive } from "@/components/guidance/GuidanceScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "CV guidance" };

/** CV guidance (sub-project 3): the recruiter rules the CVs follow, with their sources. Live data. */
export default function GuidancePage() {
  return (
    <Page width="narrow">
      <GuidanceLive />
    </Page>
  );
}
