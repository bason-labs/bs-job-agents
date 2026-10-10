import { Briefcase } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Applications" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="wide"
      icon={<Briefcase aria-hidden />}
      heading="No applications yet"
      description="Every submitted application is listed here with its CV version, screenshot and status. Click a row for the full submission record."
    />
  );
}
