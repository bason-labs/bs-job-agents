"use client";

import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { useTheme } from "./ThemeProvider";

/** Prototype top-bar button: shows the theme you switch *to* ("☀︎ Light" / "☾ Dark"). */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, toggle } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      data-testid="theme-toggle"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/70 px-3 py-1.5 text-sm text-fg transition hover:border-accent",
        className,
      )}
    >
      {next === "light" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
      <span>{next === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}
