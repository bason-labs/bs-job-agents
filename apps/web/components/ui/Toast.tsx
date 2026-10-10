"use client";

import * as RadixToast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ToastTone = "ok" | "err" | "info";

export interface ToastOptions {
  title: ReactNode;
  tone?: ToastTone;
  /** e.g. { label: "Undo", onClick: restore }. Clicking it closes the toast. */
  action?: { label: string; onClick: () => void; altText?: string };
  /** ms; defaults to 3500, or 6000 when there is an action (prototype timings). */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  open: boolean;
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.map((t) => (t.id === id ? { ...t, open: false } : t)));
    // Let the close animation finish before unmounting.
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 300);
  }, []);

  const toast = useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { ...opts, id, open: true }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="right" label="Notification">
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            open={t.open}
            onOpenChange={(open) => !open && dismiss(t.id)}
            duration={t.duration ?? (t.action ? 6000 : 3500)}
            data-testid="toast"
            data-tone={t.tone ?? "ok"}
            className={cn(
              "animate-toast-in flex items-center gap-3 rounded-2xl border bg-surface px-4 py-2 text-xs shadow-2xl",
              "data-[state=closed]:opacity-0 data-[state=closed]:transition-opacity data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
              t.tone === "err" ? "border-danger text-danger" : "border-accent/50 text-fg",
            )}
          >
            <RadixToast.Title className="flex-1">{t.title}</RadixToast.Title>
            {t.action ? (
              <RadixToast.Action altText={t.action.altText ?? t.action.label} asChild>
                <button type="button" onClick={t.action.onClick} className="font-semibold text-accent hover:underline">
                  {t.action.label}
                </button>
              </RadixToast.Action>
            ) : null}
            <RadixToast.Close aria-label="Dismiss" className="grid size-5 place-items-center rounded-md text-muted hover:text-fg">
              <X aria-hidden className="size-3" />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed right-4 bottom-4 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
