import { Bot } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlaceholderPage } from "@/components/shell/Page";
import { api } from "@/lib/api";

interface Props {
  params: Promise<{ name: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const bot = await api.getBot((await params).name);
  return { title: bot ? `${bot.displayName} · Bots` : "Bots" };
}

// Phase 1 placeholder; the real screen is built in Phase 3.
export default async function Page({ params }: Props) {
  const { name } = await params;
  const bot = await api.getBot(name);
  if (!bot) notFound();
  return (
    <PlaceholderPage
      width="narrow"
      icon={<Bot aria-hidden />}
      heading={`${bot.displayName} settings`}
      description={bot.role}
    />
  );
}
