import { Hash } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlaceholderPage } from "@/components/shell/Page";
import { api } from "@/lib/api";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const room = await api.getRoom((await params).id);
  return { title: room ? `# ${room.name}` : "Room" };
}

// Phase 1 placeholder; the real screen is built in Phase 3.
export default async function Page({ params }: Props) {
  const { id } = await params;
  const room = await api.getRoom(id);
  if (!room) notFound();
  return (
    <PlaceholderPage
      width="full"
      icon={<Hash aria-hidden />}
      heading={`# ${room.name}`}
      description="Group chat with @mentions; bots answer in discussion mode."
    />
  );
}
