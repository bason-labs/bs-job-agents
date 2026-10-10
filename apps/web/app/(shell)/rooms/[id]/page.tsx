import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { roomsData } from "@/components/rooms/data";
import { RoomScreen } from "@/components/rooms/RoomScreen";
import { Page } from "@/components/shell/Page";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const room = await roomsData.getRoom((await params).id);
  return { title: room ? `# ${room.name}` : "Room" };
}

/** UC-15: group room with @mentions; bots answer in discussion mode (full width, like chat). */
export default async function RoomPage({ params }: Props) {
  const { id } = await params;
  const room = await roomsData.getRoom(id);
  if (!room) notFound();
  const [messages, bots] = await Promise.all([roomsData.messages(id), roomsData.bots()]);
  return (
    <Page width="full">
      <RoomScreen room={room} initialMessages={messages} bots={bots} />
    </Page>
  );
}
