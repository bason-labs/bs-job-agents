import type { Metadata } from "next";
import { ActivityLive } from "@/components/activity/ActivityScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Activity" };

/** The activity log: what the system changed on its own (CV guidance rules, skill repairs, API changes). Live data. */
export default function ActivityPage() {
  return (
    <Page width="narrow">
      <ActivityLive />
    </Page>
  );
}
