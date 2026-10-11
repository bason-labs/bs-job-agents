"use client";

import type { Message, Upload } from "@bs-job-agents/shared";
import { MessageSquareOff } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessagesPage } from "@/lib/api/contract";
import { errorMessage } from "@/lib/api/errors";
import { useRooms } from "@/lib/api/hooks";
import { useApi, useAppEvents, useResource } from "@/lib/api/react";
import { Page } from "@/components/shell/Page";
import { useShell } from "@/components/shell/ShellContext";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { BotTabs } from "./BotTabs";
import { ChatContext, botDisplay, type ChatContextValue } from "./ChatContext";
import { Composer } from "./Composer";
import { BotBlock, DraftItem, MessageItem, TypingItem } from "./MessageItem";
import { RichText } from "./RichText";
import { CONSULT_SUGGESTIONS, LEAD_GREETING, LEAD_SUGGESTIONS, consultGreeting, mergeMessages, taskPhaseOf, type TaskPhase } from "./model";

const PAGE_SIZE = 50;
const TYPING_TIMEOUT_MS = 90_000;

/**
 * Chat (§11): Lead's chat at /chat, consult threads at /chat/<bot> (UC-25). Bot tabs, the
 * consult-mode banner, messages with their cards (run trace, questions, pauses, hand-offs),
 * streamed replies, and the composer with attachments (UC-24).
 */
export function ChatScreen({ botName }: { botName: string }) {
  const api = useApi();
  const { data: shell } = useShell();
  const bots = shell.bots;
  const bot = bots.find((b) => b.name === botName);
  const display = bot?.displayName ?? botDisplay(bots, botName);
  const consult = botName !== "lead";

  const rooms = useRooms();
  const room = rooms.data?.find((r) => (consult ? r.kind === "direct" && r.botName === botName : r.kind === "lead"));
  const roomId = room?.id ?? null;
  const page = useResource<MessagesPage>(roomId ? `messages:${roomId}` : null, (a) => a.listMessages(roomId!, { limit: PAGE_SIZE }));

  const [older, setOlder] = useState<Message[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [typingSince, setTypingSince] = useState<number | null>(null);
  const [phases, setPhases] = useState<Record<string, TaskPhase>>({});
  const [taskBots, setTaskBots] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<Record<string, Upload>>({});
  const [error, setError] = useState<string | null>(null);
  const { mutate } = page;

  // Live updates for this room and the tasks its cards wait on.
  useAppEvents((e) => {
    if (e.type === "message.created" && e.roomId === roomId) {
      mutate((prev) => ({ messages: mergeMessages(prev?.messages ?? [], [e.message]), hasMore: prev?.hasMore ?? false }));
      setDrafts((d) => {
        if (!(e.message.id in d)) return d;
        const { [e.message.id]: _done, ...rest } = d;
        return rest;
      });
      if (e.message.author.type !== "ba") setTypingSince(null);
    } else if (e.type === "message.delta" && e.roomId === roomId) {
      setDrafts((d) => ({ ...d, [e.messageId]: (d[e.messageId] ?? "") + e.delta }));
      setTypingSince(null);
    } else {
      const phase = taskPhaseOf(e);
      if (phase) {
        setPhases((p) => ({ ...p, [phase[0]]: phase[1] }));
        if ("botName" in e) setTaskBots((b) => ({ ...b, [phase[0]]: e.botName }));
      }
    }
  });

  useEffect(() => {
    if (typingSince === null) return;
    const t = setTimeout(() => setTypingSince(null), TYPING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [typingSince]);

  const messages = useMemo(() => mergeMessages(older, page.data?.messages ?? []), [older, page.data]);
  const hasMore = olderHasMore ?? page.data?.hasMore ?? false;

  const loadOlder = async () => {
    if (!roomId || !messages.length) return;
    setLoadingOlder(true);
    try {
      const res = await api.listMessages(roomId, { before: messages[0]!.id, limit: PAGE_SIZE });
      setOlder((o) => mergeMessages(o, res.messages));
      setOlderHasMore(res.hasMore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = useCallback(
    async (text: string, files: File[]): Promise<boolean> => {
      if (!roomId) return false;
      setError(null);
      try {
        let uploadIds: string[] = [];
        if (files.length) {
          const res = await api.uploadFiles(files);
          setUploads((u) => ({ ...u, ...Object.fromEntries(res.uploads.map((x) => [x.id, x])) }));
          if (res.rejected.length) setError(res.rejected.map((r) => r.reason).join(" "));
          if (!res.uploads.length && !text) return false;
          uploadIds = res.uploads.map((x) => x.id);
        }
        const message = await api.sendMessage({ roomId, text, uploadIds });
        mutate((prev) => ({ messages: mergeMessages(prev?.messages ?? [], [message]), hasMore: prev?.hasMore ?? false }));
        setTypingSince(Date.now());
        return true;
      } catch (err) {
        setError(`Couldn't send: ${errorMessage(err)}`);
        return false;
      }
    },
    [api, roomId, mutate],
  );

  // Stick to the bottom while new messages arrive, unless Ba scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const draftText = Object.values(drafts).join("");
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, draftText, typingSince]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const ctx: ChatContextValue | null = useMemo(
    () =>
      room
        ? {
            room,
            bots,
            messages,
            taskPhase: (id: string) => phases[id],
            taskBot: (id: string) => taskBots[id],
            uploads,
          }
        : null,
    [room, bots, messages, phases, taskBots, uploads],
  );

  const roomMissing = rooms.data !== undefined && !room;
  const loading = !roomMissing && (rooms.data === undefined || (page.data === undefined && !page.error));
  const loadError = rooms.error ?? page.error;

  return (
    <Page width="full" className="relative">
      <div aria-hidden className="pointer-events-none absolute -top-32 left-1/4 h-64 w-1/2 rounded-full bg-gradient-brand opacity-25 blur-3xl" />
      <div className="relative px-4 pt-4 md:px-6">
        <div className="mx-auto max-w-2xl space-y-2">
          <BotTabs bots={bots} active={botName} />
          {consult ? (
            <p data-testid="consult-banner" className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-muted">
              <b className="text-fg">Direct chat with {display}</b> · consult mode — it answers within its role and memory, but can&apos;t start work. Work requests are handed to Lead
              automatically.
            </p>
          ) : null}
        </div>
      </div>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-6 md:px-6">
          {roomMissing ? (
            <EmptyState
              icon={<MessageSquareOff aria-hidden />}
              title={`No chat with ${display} yet`}
              description="The orchestrator has no room for this bot. It creates the Lead chat and one consult chat per bot."
            />
          ) : loadError && !page.data ? (
            <div role="alert" className="space-y-2 rounded-2xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
              <p>Couldn&apos;t load the chat: {errorMessage(loadError)}</p>
              <Button size="sm" onClick={() => void (rooms.error ? rooms.reload() : page.reload())}>
                Retry
              </Button>
            </div>
          ) : loading || !ctx ? (
            <div className="space-y-5" aria-busy data-testid="chat-loading">
              <Skeleton className="ml-auto h-10 w-2/3 rounded-3xl" />
              <Skeleton className="h-16 w-5/6 rounded-2xl" />
              <Skeleton className="h-24 w-full rounded-2xl" />
            </div>
          ) : (
            <ChatContext.Provider value={ctx}>
              {hasMore ? (
                <div className="flex justify-center">
                  <Button size="sm" variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>
                    Load earlier messages
                  </Button>
                </div>
              ) : null}
              {messages.length === 0 ? (
                <BotBlock bot={botName} consult={consult}>
                  <p className="leading-relaxed" data-testid="greeting">
                    <RichText text={consult ? consultGreeting(botName, display) : LEAD_GREETING} />
                  </p>
                </BotBlock>
              ) : null}
              {messages.map((m) => (
                <MessageItem key={m.id} message={m} />
              ))}
              {Object.entries(drafts).map(([id, text]) => (
                <DraftItem key={id} bot={room?.botName ?? "lead"} consult={consult} text={text} />
              ))}
              {typingSince !== null && Object.keys(drafts).length === 0 ? <TypingItem bot={botName} consult={consult} /> : null}
            </ChatContext.Provider>
          )}
        </div>
      </div>

      <div className="relative px-4 pb-4 md:px-6 md:pb-5">
        <div className="mx-auto max-w-2xl space-y-2">
          {error ? (
            <p role="alert" data-testid="chat-error" className="rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <Composer bot={bot} botName={botName} suggestions={consult ? CONSULT_SUGGESTIONS : LEAD_SUGGESTIONS} onSend={send} disabled={!roomId} />
        </div>
      </div>
    </Page>
  );
}
