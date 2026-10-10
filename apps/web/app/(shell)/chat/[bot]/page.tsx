import { MessageSquare } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlaceholderPage } from "@/components/shell/Page";
import { api } from "@/lib/api";

interface Props {
  params: Promise<{ bot: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const bot = await api.getBot((await params).bot);
  return { title: bot ? `Chat with ${bot.displayName}` : "Chat" };
}

// Phase 1 placeholder; the real screen is built in Phase 3.
export default async function Page({ params }: Props) {
  const { bot: botName } = await params;
  const bot = await api.getBot(botName);
  if (!bot) notFound();
  return (
    <PlaceholderPage
      width="full"
      icon={<MessageSquare aria-hidden />}
      heading={`Direct chat with ${bot.displayName}`}
      description={
        bot.name === "lead"
          ? "Lead takes every request and hands work to the team."
          : "Consult mode: it answers within its role and memory, but can't start work. Work requests are handed to Lead automatically."
      }
    />
  );
}
