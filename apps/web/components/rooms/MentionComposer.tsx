"use client";

import { ArrowUp } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { BotAvatar } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { RoomBot } from "./data";
import { applyMention, mentionOptions, mentionQuery } from "./mentions";

export interface MentionComposerProps {
  roomName: string;
  members: readonly RoomBot[];
  onSend: (text: string) => Promise<void> | void;
}

/**
 * Room composer with @mention autocomplete (UC-15). Typing "@" lists the room's bots;
 * ↑/↓ move, Enter or Tab inserts "@Name ", Esc closes. Focus stays in the input.
 */
export function MentionComposer({ roomName, members, onSend }: MentionComposerProps) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const match = mentionQuery(text, caret);
  const options = match ? mentionOptions(match.query, members) : [];
  const open = !!match && options.length > 0 && !dismissed;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // Put the caret after an inserted mention once React has rendered the new text.
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !inputRef.current) return;
    inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? text.length);

  const choose = (i: number) => {
    const bot = options[i];
    if (!match || !bot) return;
    const next = applyMention(text, match, caret, bot.displayName);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    setActive(0);
    inputRef.current?.focus();
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onSend(t);
      setText("");
      setCaret(0);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = options.length;
        setActive((activeIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(activeIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative">
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Mention a bot"
          data-testid="mention-list"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute bottom-full left-3 z-20 mb-2 w-72 rounded-2xl border border-border bg-surface p-1 shadow-2xl"
        >
          {options.map((bot, i) => (
            <div
              key={bot.name}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={cn("flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm", i === activeIndex && "bg-surface-2")}
            >
              <BotAvatar name={bot.displayName} lead={bot.name === "lead"} />
              <span className="min-w-0">
                <span className="block font-medium">{bot.displayName}</span>
                <span className="block truncate text-[11px] text-muted">{bot.role}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2 rounded-3xl border border-border bg-surface/80 p-3 shadow-glow transition focus-within:border-accent">
        <input
          ref={inputRef}
          role="combobox"
          aria-label={`Message #${roomName}`}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          value={text}
          placeholder={`Message #${roomName} — try @Research @CV …`}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissed(false);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") && syncCaret()}
          onClick={syncCaret}
          onBlur={() => setDismissed(true)}
          onFocus={() => setDismissed(false)}
          // role=combobox gets the global pointer cursor; this is a text field.
          className="min-w-0 flex-1 cursor-text bg-transparent px-2 text-sm outline-none placeholder:text-muted/70 focus-visible:shadow-none!"
        />
        <button
          type="button"
          aria-label="Send"
          disabled={!text.trim() || sending}
          onClick={() => void send()}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-brand text-white shadow-glow transition disabled:opacity-50"
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
