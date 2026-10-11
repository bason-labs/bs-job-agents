import type { Metadata } from "next";
import { ApplicationsLive } from "@/components/applications/ApplicationsScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Applications" };

/** UC-13 / UC-13b: applications table, submission record panel, ZIP export (wide, centered). Live data, read in the browser. */
export default function ApplicationsPage() {
  return (
    <Page width="wide">
      <ApplicationsLive />
    </Page>
  );
}
