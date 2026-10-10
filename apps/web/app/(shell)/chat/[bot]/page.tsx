import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatScreen } from "@/components/chat/ChatScreen";
import { api } from "@/lib/api";

interface Props {
  params: Promise<{ bot: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const bot = await api.getBot((await params).bot);
  return { title: bot ? `Chat with ${bot.displayName}` : "Chat" };
}

/** A consult thread with one bot (UC-25); /chat/lead redirects to /chat in next.config. */
export default async function Page({ params }: Props) {
  const bot = await api.getBot((await params).bot);
  if (!bot) notFound();
  return <ChatScreen botName={bot.name} />;
}
