import type { Metadata } from "next";
import { schedulesData } from "@/components/schedules/data";
import { SchedulesScreen } from "@/components/schedules/SchedulesScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Schedules" };

/** UC-21: scheduled job scans (centered, max-w-3xl as in the prototype). */
export default async function SchedulesPage() {
  const [schedules, profiles] = await Promise.all([schedulesData.list(), schedulesData.profiles()]);
  return (
    <Page width="narrow">
      <SchedulesScreen initial={schedules} profiles={profiles} />
    </Page>
  );
}
