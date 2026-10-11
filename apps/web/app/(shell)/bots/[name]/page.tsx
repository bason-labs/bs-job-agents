import type { Metadata } from "next";
import { BotsLive } from "@/components/bots/BotsScreen";
import { Page } from "@/components/shell/Page";
import { api } from "@/lib/api";

interface Props {
  params: Promise<{ name: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const bot = await api.getBot((await params).name).catch(() => null);
  return { title: bot ? `${bot.displayName} · Bots` : "Bots" };
}

/** A bot's settings (sidebar ⚙, UC-25 b): engine, enabled, trust, promotion, memory. Live data, read in the browser. */
export default async function BotSettingsPage({ params }: Props) {
  const { name } = await params;
  return (
    <Page width="narrow">
      <BotsLive only={name} />
    </Page>
  );
}
