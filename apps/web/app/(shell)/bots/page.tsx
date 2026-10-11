import type { Metadata } from "next";
import { botsData } from "@/components/bots/data";
import { BotsScreen } from "@/components/bots/BotsScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Bots" };

/** §11 Bots: every bot's role, engine, trust level, track record, promotion and memory (two-column grid). */
export default async function BotsPage() {
  const bots = await botsData.list();
  return (
    <Page width="wide">
      <BotsScreen initial={bots} />
    </Page>
  );
}
