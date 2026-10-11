import type { Metadata } from "next";
import { BotsLive } from "@/components/bots/BotsScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Bots" };

/** §11 Bots: every bot's role, engine, trust level, track record, promotion and memory (two-column grid), then Lead's workflow proposals. Live data. */
export default function BotsPage() {
  return (
    <Page width="wide">
      <BotsLive />
    </Page>
  );
}
