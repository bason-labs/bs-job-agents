import { Bot } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Bots" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="narrow"
      icon={<Bot aria-hidden />}
      heading="Bots"
      description="Each bot's role, engine, trust level, track record, prompt version and memory."
    />
  );
}
