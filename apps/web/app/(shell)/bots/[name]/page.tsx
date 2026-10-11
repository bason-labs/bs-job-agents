import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { botsData } from "@/components/bots/data";
import { BotsScreen } from "@/components/bots/BotsScreen";
import { Page } from "@/components/shell/Page";

interface Props {
  params: Promise<{ name: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const bot = await botsData.get((await params).name);
  return { title: bot ? `${bot.displayName} · Bots` : "Bots" };
}

/** A bot's settings (sidebar ⚙, UC-25 b): engine, enabled, trust, promotion, memory. */
export default async function BotSettingsPage({ params }: Props) {
  const { name } = await params;
  const bots = await botsData.list();
  if (!bots.some((b) => b.name === name)) notFound();
  return (
    <Page width="narrow">
      <BotsScreen initial={bots} only={name} />
    </Page>
  );
}
