"use client";

import type { ChatMessage } from "@bs-job-agents/shared";
import { ENGINE_NAMES } from "@/lib/api/map";
import { formatWhen } from "@/lib/datetime";
import { BotAvatar } from "@/components/ui/Avatar";
import { MessageAttachments } from "./Attachments";
import { botDisplay, useChat } from "./ChatContext";
import { MessageCards } from "./MessageCards";
import { RichText } from "./RichText";

/** Bot header: avatar, name, engine chip, consult chip, time. */
export function BotHeader({ bot, consult, at }: { bot: string; consult: boolean; at?: string }) {
  const { bots } = useChat();
  const summary = bots.find((b) => b.name === bot);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-display font-semibold">{botDisplay(bots, bot)}</span>
      {summary ? <span className="rounded-full border border-border px-2 text-[10px] text-muted">{ENGINE_NAMES[summary.engine]}</span> : null}
      {consult ? <span className="rounded-full border border-accent/40 px-2 text-[10px] text-accent">consult</span> : null}
      {at ? <time dateTime={at} className="text-[10px] text-muted">{formatWhen(at)}</time> : null}
    </div>
  );
}

/** A bot's block: avatar on the left, header, text (streamed with a caret) and cards. */
export function BotBlock({ bot, consult, at, children }: { bot: string; consult: boolean; at?: string; children: React.ReactNode }) {
  const { bots } = useChat();
  return (
    <div className="flex gap-3" data-testid="message" data-author={bot}>
      <BotAvatar name={botDisplay(bots, bot)} lead={bot === "lead"} size="md" />
      <div className="min-w-0 flex-1 space-y-2.5">
        <BotHeader bot={bot} consult={consult} at={at} />
        {children}
      </div>
    </div>
  );
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const { author } = message;
  if (author.type === "ba") {
    return (
      <div className="flex flex-col items-end gap-1.5" data-testid="message" data-author="ba">
        {message.text ? (
          <div className="max-w-[80%] rounded-3xl rounded-br-md border border-border bg-surface-2 px-4 py-3 break-words whitespace-pre-wrap">{message.text}</div>
        ) : null}
        <MessageAttachments message={message} />
      </div>
    );
  }
  if (author.type === "system") {
    return (
      <p className="mx-auto text-center text-xs text-warn" data-testid="message" data-author="system">
        {message.text}
      </p>
    );
  }
  return (
    <BotBlock bot={author.bot} consult={message.mode === "consult"} at={message.createdAt}>
      {message.text ? (
        <p className="leading-relaxed break-words whitespace-pre-wrap">
          <RichText text={message.text} />
        </p>
      ) : null}
      <MessageCards message={message} />
    </BotBlock>
  );
}

/** A reply being written (message.delta), before message.created replaces it. */
export function DraftItem({ bot, consult, text }: { bot: string; consult: boolean; text: string }) {
  return (
    <BotBlock bot={bot} consult={consult}>
      <p className="leading-relaxed break-words whitespace-pre-wrap" data-testid="streaming">
        <RichText text={text} />
        <span aria-hidden className="ml-1 inline-block h-3.5 w-1.5 animate-blink bg-accent align-[-2px]" />
      </p>
    </BotBlock>
  );
}

/** "Lead is typing…" after Ba sent something and before the reply arrives. */
/** PM3 S5: "<Bot> is working" while its conversation task runs, with its latest tool steps. */
export function TypingItem({ bot, consult, steps = [] }: { bot: string; consult: boolean; steps?: readonly string[] }) {
  const { bots } = useChat();
  return (
    <BotBlock bot={bot} consult={consult}>
      <div role="status" data-testid="typing" className="space-y-1">
        <p className="flex items-center gap-1 text-xs text-muted">
          {botDisplay(bots, bot)} is working
          <span aria-hidden className="inline-flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </span>
        </p>
        {steps.length ? (
          <ul data-testid="working-steps" className="space-y-0.5 text-[11px] text-muted">
            {steps.map((s, i) => (
              <li key={`${i}-${s}`} className={i === steps.length - 1 ? "text-fg/80" : undefined}>
                {s}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </BotBlock>
  );
}
