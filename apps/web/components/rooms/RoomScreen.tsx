"use client";

import { ROOM_MENTION_CAP, type Message, type Room } from "@bs-job-agents/shared";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BotAvatar, Button, EmptyState, useToast } from "@/components/ui";
import { errorText } from "@/components/schedules/apiError";
import { ResourceGate } from "@/components/schedules/ResourceGate";
import { useResource } from "@/lib/api/react";
import { mentionableBots, useRoomsData, type RoomBot, type RoomsData } from "./data";
import { roomMentions, splitMentions } from "./mentions";
import { MentionComposer } from "./MentionComposer";

export interface RoomScreenProps {
  room: Room;
  initialMessages: Message[];
  /** Older messages exist (the API pages history). */
  initialHasMore?: boolean;
  bots: RoomBot[];
  data: RoomsData;
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

/** The page (/rooms/[id]): the room, its latest messages and the bots, read through lib/api. */
export function RoomLive({ id }: { id: string }) {
  const data = useRoomsData();
  const read = useResource(`w3c:room:${id}`, async () => {
    const [room, page, bots] = await Promise.all([data.getRoom(id), data.messages(id).catch(() => null), data.bots()]);
    return { room, page, bots };
  });
  return (
    <ResourceGate resource={read} label="room">
      {({ room, page, bots }) =>
        room && page ? (
          // One mount per room; later re-reads don't reset the conversation (live events keep it current).
          <RoomScreen key={room.id} room={room} initialMessages={page.messages} initialHasMore={page.hasMore} bots={bots} data={data} />
        ) : (
          <EmptyState
            icon={<SearchX aria-hidden />}
            title="Not found"
            description={
              <>
                There is no room “{id}”.{" "}
                <Link href="/rooms" className="text-accent hover:underline">
                  All rooms
                </Link>
              </>
            }
          />
        )
      }
    </ResourceGate>
  );
}

/** UC-15: group room in discussion mode. Bots answer only when @mentioned and never act here. */
export function RoomScreen({ room, initialMessages, initialHasMore = false, bots, data }: RoomScreenProps) {
  const [messages, setMessages] = useState(initialMessages);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [waiting, setWaiting] = useState<string[]>([]);
  const notes = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const members = bots.filter((b) => room.members.includes(b.name));
  const mentionable = mentionableBots(room, bots);
  const displayName = (name: string) => bots.find((b) => b.name === name)?.displayName ?? name;

  const append = (m: Message) => setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));

  // Replies and system notes arrive as message.created events (SSE); a bot that fails stops "answering".
  const latestBots = useRef(bots);
  useEffect(() => {
    latestBots.current = bots;
  });
  useEffect(
    () =>
      data.subscribe(room.id, {
        onMessage: (m) => {
          append(m);
          if (m.author.type === "bot") {
            const bot = m.author.bot;
            setWaiting((w) => w.filter((b) => b !== bot));
          } else if (m.author.type === "system") {
            // "@CV will not answer: …" / "@Apply is not in this room."
            const named = latestBots.current.filter((b) => m.text.includes(`@${b.displayName}`)).map((b) => b.name);
            if (named.length) setWaiting((w) => w.filter((b) => !named.includes(b)));
          }
        },
        onBotStopped: (bot) => setWaiting((w) => w.filter((b) => b !== bot)),
      }),
    [data, room.id],
  );

  // Follow the newest message (not older pages loaded at the top).
  const newestId = messages.at(-1)?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newestId, waiting.length]);

  const loadEarlier = async () => {
    const oldest = messages.find((m) => !m.id.startsWith("local_"));
    setLoadingEarlier(true);
    try {
      const page = await data.messages(room.id, { before: oldest?.id, limit: 50 });
      setMessages((ms) => [...page.messages.filter((m) => !ms.some((x) => x.id === m.id)), ...ms]);
      setHasMore(page.hasMore);
    } catch (e) {
      toast({ title: `Couldn't load earlier messages: ${errorText(e)}`, tone: "err" });
    } finally {
      setLoadingEarlier(false);
    }
  };

  const send = async (text: string) => {
    const mentioned = roomMentions(text, mentionable).slice(0, ROOM_MENTION_CAP);
    // Shown before the request returns: the orchestrator may post the first reply right away.
    if (mentioned.length) setWaiting((w) => [...w, ...mentioned.filter((b) => !w.includes(b))]);
    try {
      append(await data.send(room.id, text));
    } catch (e) {
      setWaiting((w) => w.filter((b) => !mentioned.includes(b)));
      toast({ title: `Couldn't send: ${errorText(e)}`, tone: "err" });
      throw e;
    }
    if (mentioned.length === 0) append(localNote(room.id, NO_MENTION, ++notes.current));
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

          {hasMore ? (
            <div className="text-center">
              <Button size="sm" pill variant="ghost" loading={loadingEarlier} onClick={() => void loadEarlier()}>
                Load earlier messages
              </Button>
            </div>
          ) : null}

          <ol aria-label={`# ${room.name} messages`} className="space-y-4">
            {messages.map((m) => (
              <li key={m.id} data-testid="room-message" data-author={m.author.type === "bot" ? m.author.bot : m.author.type}>
                {m.author.type === "ba" ? (
                  <div className="flex justify-end">
                    <p className="max-w-[80%] rounded-3xl rounded-br-md border border-border bg-surface-2 px-4 py-3 whitespace-pre-wrap">
                      <MessageText text={m.text} members={mentionable} />
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
                      <p className="leading-relaxed whitespace-pre-wrap">
                        <MessageText text={m.text} members={mentionable} />
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
          <MentionComposer roomName={room.name} members={mentionable} onSend={send} />
        </div>
      </div>
    </div>
  );
}
