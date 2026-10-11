"use client";

import { useCallback, useRef, type RefObject } from "react";

/**
 * Focus return for layers opened from code (W3c request): Radix only refocuses a Dialog.Trigger, so a
 * dialog, viewer or drawer opened by `setOpen(true)` would leave focus on <body> when it closes.
 * Spread the handlers on the Radix Content: the element focused when the layer opened (or
 * `returnFocus` when given) gets focus back on close.
 */
export function useReturnFocus(returnFocus?: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  const onOpenAutoFocus = useCallback(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      const target = returnFocus?.current ?? opener.current;
      opener.current = null;
      if (target && target.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
    [returnFocus],
  );
  return { onOpenAutoFocus, onCloseAutoFocus };
}
