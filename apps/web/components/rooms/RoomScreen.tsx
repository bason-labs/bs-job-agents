"use client";

import type { Message, Room } from "@bs-job-agents/shared";
import { useEffect, useRef, useState } from "react";
import { BotAvatar, useToast } from "@/components/ui";
import { roomsData, type RoomBot, type RoomsData } from "./data";
import { roomMentions, splitMentions } from "./mentions";
import { MentionComposer } from "./MentionComposer";

export interface RoomScreenProps {
  room: Room;
  initialMessages: Message[];
  bots: RoomBot[];
  /** Defaults to the app's data source; tests pass their own. */
  data?: RoomsData;
}

const NO_MENTION = "No bot mentioned — type @ to ask a specific bot.";

/** A note shown only in this browser (never sent): the room's system hints. */
const localNote = (roomId: string, text: string, n: number): Message => ({
  id: `local_${n}`,
  roomId,
  author: { type: "system" },
  text,
  mode: "discussion",
  mentions: [],
  runIds: [],
  uploadIds: [],
  cards: [],
  createdAt: new Date().toISOString(),
});

function MessageText({ text, members }: { text: string; members: readonly RoomBot[] }) {
  return (
    <>
      {splitMentions(text, members).map((part, i) =>
        part.mention ? (
          <span key={i} className="font-medium text-accent">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** UC-15: group room in discussion mode. Bots answer only when @mentioned and never act here. */
export function RoomScreen({ room, initialMessages, bots, data = roomsData }: RoomScreenProps) {
  const [messages, setMessages] = useState(initialMessages);
  const [waiting, setWaiting] = useState<string[]>([]);
  const notes = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const members = bots.filter((b) => room.members.includes(b.name));
  const displayName = (name: string) => bots.find((b) => b.name === name)?.displayName ?? name;

  const append = (m: Message) => setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));

  // Replies arrive as message.created events.
  useEffect(
    () =>
      data.subscribe(room.id, (m) => {
        append(m);
        if (m.author.type === "bot") {
          const bot = m.author.bot;
          setWaiting((w) => w.filter((b) => b !== bot));
        }
      }),
    [data, room.id],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, waiting.length]);

  const send = async (text: string) => {
    const mentioned = roomMentions(text, members);
    try {
      append(await data.send(room.id, text));
    } catch (e) {
      toast({ title: `Couldn't send: ${e instanceof Error ? e.message : String(e)}`, tone: "err" });
      throw e;
    }
    if (mentioned.length === 0) append(localNote(room.id, NO_MENTION, ++notes.current));
    else setWaiting((w) => [...w, ...mentioned.filter((b) => !w.includes(b))]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-6">
          <div className="space-y-2 text-center">
            <p className="text-xs text-muted">Discussion mode — bots answer only when @mentioned and never take actions here.</p>
            <p data-testid="room-members" className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-muted">
              <span>Members:</span>
              {members.map((b) => (
                <span key={b.name} className="flex items-center gap-1 rounded-full border border-border bg-surface/60 py-0.5 pr-2 pl-0.5">
                  <BotAvatar name={b.displayName} lead={b.name === "lead"} className="size-4 text-[8px]" />
                  {b.displayName}
                </span>
              ))}
            </p>
          </div>

          <ol aria-label={`# ${room.name} messages`} className="space-y-4">
            {messages.map((m) => (
              <li key={m.id} data-testid="room-message" data-author={m.author.type === "bot" ? m.author.bot : m.author.type}>
                {m.author.type === "ba" ? (
                  <div className="flex justify-end">
                    <p className="max-w-[80%] rounded-3xl rounded-br-md border border-border bg-surface-2 px-4 py-3">
                      <MessageText text={m.text} members={members} />
                    </p>
                  </div>
                ) : m.author.type === "system" ? (
                  <p role="status" className="text-center text-xs text-warn">
                    {m.text}
                  </p>
                ) : (
                  <div className="flex gap-3">
                    <BotAvatar name={displayName(m.author.bot)} lead={m.author.bot === "lead"} size="md" />
                    <div className="min-w-0">
                      <p className="font-display text-xs font-semibold">{displayName(m.author.bot)}</p>
                      <p className="leading-relaxed">
                        <MessageText text={m.text} members={members} />
                      </p>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>

          {waiting.length ? (
            <p data-testid="room-waiting" className="flex items-center gap-2 text-xs text-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              {waiting.map(displayName).join(", ")} {waiting.length === 1 ? "is" : "are"} answering…
            </p>
          ) : null}
        </div>
      </div>
      <div className="px-4 pb-5 sm:px-6">
        <div className="mx-auto max-w-2xl">
          <MentionComposer roomName={room.name} members={members} onSend={send} />
        </div>
      </div>
    </div>
  );
}
