import type { Metadata } from "next";
import { RoomLive } from "@/components/rooms/RoomScreen";
import { Page } from "@/components/shell/Page";
import { api } from "@/lib/api";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const room = await api.getRoom((await params).id).catch(() => null);
  return { title: room ? `# ${room.name}` : "Room" };
}

/**
 * UC-15: group room with @mentions; bots answer in discussion mode (full width, like chat). Read in
 * the browser: Ba's messages go out with POST /chat/messages, replies arrive as message.created.
 */
export default async function RoomPage({ params }: Props) {
  const { id } = await params;
  return (
    <Page width="full">
      <RoomLive id={id} />
    </Page>
  );
}
