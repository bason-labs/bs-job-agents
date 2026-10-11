import type { Metadata } from "next";
import { ApplicationsScreen } from "@/components/applications/ApplicationsScreen";
import { applicationsData } from "@/components/applications/data";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Applications" };

/** UC-13 / UC-13b: applications table, submission record panel, ZIP export (wide, centered). */
export default async function ApplicationsPage() {
  const initial = await applicationsData.list();
  return (
    <Page width="wide">
      <ApplicationsScreen initial={initial} />
    </Page>
  );
}
