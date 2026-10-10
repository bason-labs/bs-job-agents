import { FileText } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Master CV" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="narrow"
      icon={<FileText aria-hidden />}
      heading="Master CV"
      description="The facts every tailored CV is built from: EN/VI text, tags, organisation and dates, with version history."
    />
  );
}
