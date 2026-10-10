import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Review" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="wide"
      icon={<ClipboardCheck aria-hidden />}
      heading="Nothing to review"
      description="Jobs that pass QA wait here for you: fit, company profile, QA breakdown, CV preview. Approve & submit, request changes or skip."
    />
  );
}
