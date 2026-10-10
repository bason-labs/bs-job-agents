import { SlidersHorizontal } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Search criteria" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="narrow"
      icon={<SlidersHorizontal aria-hidden />}
      heading="Search criteria"
      description="Roles, locations, salary floor, sources and fit threshold for the active Search Profile."
    />
  );
}
