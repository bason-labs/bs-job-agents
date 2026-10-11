import type { Metadata } from "next";
import { MasterCvLive } from "@/components/cv/MasterCvScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Master CV" };

/** UC-20: the facts every tailored CV is built from (centered, max-w-3xl as in the prototype). Live data. */
export default function MasterCvPage() {
  return (
    <Page width="narrow">
      <MasterCvLive />
    </Page>
  );
}
