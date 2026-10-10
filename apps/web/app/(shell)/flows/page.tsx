import { Workflow } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Flows" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="full"
      icon={<Workflow aria-hidden />}
      heading="No flows yet"
      description="Workflow runs show here as a live canvas: one node per step, animated edges while running, QA loop and the locked Apply step."
    />
  );
}
