"use client";

import type { Room } from "@bs-job-agents/shared";
import { Hash, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { errorText } from "@/components/schedules/apiError";
import { ResourceGate } from "@/components/schedules/ResourceGate";
import { BotAvatar, Button, Checkbox, Field, Input, useToast } from "@/components/ui";
import { useResource } from "@/lib/api/react";
import { botChatHref, roomHref } from "@/lib/routes";
import { useRoomsData, type RoomBot, type RoomsData } from "./data";

const ROOM_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The page (/rooms): group rooms, the direct threads with each bot (GET /rooms), and a new room. */
export function RoomsLive() {
  const data = useRoomsData();
  const read = useResource("w3c:rooms", async () => {
    const [rooms, bots] = await Promise.all([data.rooms(), data.bots()]);
    return { rooms, bots };
  });
  return (
    <ResourceGate resource={read} label="rooms" rows={3}>
      {({ rooms, bots }) => <RoomsScreen rooms={rooms} bots={bots} data={data} onCreated={() => void read.reload()} />}
    </ResourceGate>
  );
}

export interface RoomsScreenProps {
  rooms: Room[];
  bots: RoomBot[];
  data: RoomsData;
  onCreated?: (room: Room) => void;
}

/** UC-15 group rooms (discussion mode) and UC-25 direct threads, one per bot. */
export function RoomsScreen({ rooms, bots, data, onCreated }: RoomsScreenProps) {
  const groups = rooms.filter((r) => r.kind === "group");
  const direct = rooms.filter((r) => r.kind === "direct" && r.botName);
  const label = (name: string) => bots.find((b) => b.name === name)?.displayName ?? name;

  return (
    <div className="space-y-6">
      <section aria-labelledby="group-rooms" className="space-y-2">
        <h2 id="group-rooms" className="font-display font-semibold">
          Group rooms
        </h2>
        <p className="text-xs text-muted">Discussion mode: bots answer only when @mentioned and never take actions. “@Lead make it a task” turns an idea into work.</p>
        {groups.length === 0 ? (
          <p data-testid="rooms-empty" className="rounded-2xl border border-dashed border-border p-4 text-center text-xs text-muted">
            No group rooms yet. Create one below to brainstorm with several bots.
          </p>
        ) : (
          <ul className="space-y-2">
            {groups.map((r) => (
              <li key={r.id}>
                <Link
                  href={roomHref(r.id)}
                  data-testid="room-link"
                  className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/60 px-4 py-3 transition hover:border-accent"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <Hash aria-hidden className="size-4 text-muted" />
                    {r.name}
                  </span>
                  <span className="truncate text-xs text-muted">{r.members.map(label).join(", ")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <NewRoom bots={bots} data={data} onCreated={onCreated} />

      <section aria-labelledby="direct-rooms" className="space-y-2">
        <h2 id="direct-rooms" className="font-display font-semibold">
          Direct threads
        </h2>
        <p className="text-xs text-muted">Ask one bot a question (consult). It answers only; work it suggests goes through Lead.</p>
        <ul className="flex flex-wrap gap-2">
          {direct.map((r) => (
            <li key={r.id}>
              <Link
                href={botChatHref(r.botName!)}
                data-testid="direct-room-link"
                className="flex items-center gap-2 rounded-full border border-border bg-surface/60 py-1 pr-3 pl-1 text-xs transition hover:border-accent"
              >
                <BotAvatar name={label(r.botName!)} className="size-6 text-[10px]" />
                {label(r.botName!)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NewRoom({ bots, data, onCreated }: { bots: RoomBot[]; data: RoomsData; onCreated?: (room: Room) => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const nameId = useId();
  const choosable = bots.filter((b) => b.name !== "lead");

  const nameError = !name.trim() ? "Name the room" : ROOM_NAME.test(name.trim()) ? null : "Room names look like cv-brainstorm (lowercase, digits, -)";
  const membersError = members.length === 0 ? "Pick at least one bot" : null;

  const create = async () => {
    setTried(true);
    if (nameError || membersError) return;
    setSaving(true);
    try {
      const room = await data.createRoom(name.trim(), members);
      toast({ title: `Created #${room.name}` });
      onCreated?.(room);
      router.push(roomHref(room.id));
    } catch (e) {
      toast({ title: `Couldn't create the room: ${errorText(e)}`, tone: "err" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="new-room" data-testid="new-room" className="space-y-3 rounded-2xl border border-border bg-surface/60 p-4">
      <h2 id="new-room" className="flex items-center gap-2 text-sm font-medium">
        <MessagesSquare aria-hidden className="size-4 text-accent" />
        New room
      </h2>
      <Field label="Name" htmlFor={nameId} error={tried ? (nameError ?? undefined) : undefined}>
        <Input id={nameId} value={name} placeholder="cv-brainstorm" invalid={tried && !!nameError} onChange={(e) => setName(e.target.value.toLowerCase())} />
      </Field>
      <div className="space-y-1">
        <p className="text-xs text-muted">Members (Lead can always be @mentioned)</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {choosable.map((b) => (
            <Checkbox
              key={b.name}
              checked={members.includes(b.name)}
              onCheckedChange={(on) => setMembers((ms) => (on ? [...ms, b.name] : ms.filter((m) => m !== b.name)))}
              label={b.displayName}
            />
          ))}
        </div>
        {tried && membersError ? (
          <p role="alert" className="text-xs text-danger">
            {membersError}
          </p>
        ) : null}
      </div>
      <Button size="sm" pill variant="primary" loading={saving} onClick={() => void create()}>
        Create room
      </Button>
    </section>
  );
}
