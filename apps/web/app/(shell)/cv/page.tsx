import type { Metadata } from "next";
import { masterCvData } from "@/components/cv/data";
import { MasterCvScreen } from "@/components/cv/MasterCvScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Master CV" };

/** UC-20: the facts every tailored CV is built from (centered, max-w-3xl as in the prototype). */
export default async function MasterCvPage() {
  const [cv, versions, requests] = await Promise.all([masterCvData.get(), masterCvData.versions(), masterCvData.factRequests()]);
  return (
    <Page width="narrow">
      <MasterCvScreen initial={cv} initialVersions={versions} initialRequests={requests} />
    </Page>
  );
}
