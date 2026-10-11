import type { Metadata } from "next";
import { SchedulesLive } from "@/components/schedules/SchedulesScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Schedules" };

/** UC-21: scheduled job scans (centered, max-w-3xl as in the prototype). Live data. */
export default function SchedulesPage() {
  return (
    <Page width="narrow">
      <SchedulesLive />
    </Page>
  );
}
