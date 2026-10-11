import type { Metadata } from "next";
import { RoomsLive } from "@/components/rooms/RoomsScreen";
import { Page } from "@/components/shell/Page";

export const metadata: Metadata = { title: "Rooms" };

/** UC-15 / UC-25: group rooms, a new room, and each bot's direct thread (GET /rooms). Live data. */
export default function RoomsPage() {
  return (
    <Page width="narrow">
      <RoomsLive />
    </Page>
  );
}
