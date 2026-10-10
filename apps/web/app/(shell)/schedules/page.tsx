import { CalendarClock } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Schedules" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="narrow"
      icon={<CalendarClock aria-hidden />}
      heading="No schedules yet"
      description="Scheduled scans run the job-scan workflow at set times (Asia/Ho_Chi_Minh)."
    />
  );
}
