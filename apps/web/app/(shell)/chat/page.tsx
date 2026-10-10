import { MessageSquare } from "lucide-react";
import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Chat" };

// Phase 1 placeholder; the real screen is built in Phase 3.
export default function Page() {
  return (
    <PlaceholderPage
      width="full"
      icon={<MessageSquare aria-hidden />}
      heading="Chat with Lead"
      description="Lead takes every request and hands work to the team. The chat screen (bot tabs, delegation trace, run cards, composer with attachments) arrives in Phase 3."
    />
  );
}
