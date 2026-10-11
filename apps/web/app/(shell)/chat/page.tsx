import type { Metadata } from "next";
import { ChatScreen } from "@/components/chat/ChatScreen";

export const metadata: Metadata = { title: "Chat" };

/** Lead's chat, the home screen (spec §11): every work request goes through Lead. */
export default function Page() {
  return <ChatScreen botName="lead" />;
}
