import type { Metadata } from "next";
import { criteriaData } from "@/components/criteria/data";
import { CriteriaScreen } from "@/components/criteria/CriteriaScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Search criteria" };

/** UC-21b: the active Search Profile (centered, max-w-3xl as in the prototype), plus UC-12 saved answers. */
export default async function CriteriaPage() {
  const [profile, versions, answers] = await Promise.all([criteriaData.get(), criteriaData.versions(), criteriaData.savedAnswers()]);
  return (
    <Page width="narrow">
      <CriteriaScreen initial={profile} initialVersions={versions.versions} initialAnswers={answers} />
    </Page>
  );
}
