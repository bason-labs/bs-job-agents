import type { Metadata } from "next";
import { criteriaData } from "@/components/criteria/data";
import { CriteriaScreen } from "@/components/criteria/CriteriaScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Search criteria" };

/** UC-21b: the active Search Profile (centered, max-w-3xl as in the prototype). */
export default async function CriteriaPage() {
  const [profile, versions] = await Promise.all([criteriaData.get(), criteriaData.versions()]);
  return (
    <Page width="narrow">
      <CriteriaScreen initial={profile} initialVersions={versions.versions} />
    </Page>
  );
}
