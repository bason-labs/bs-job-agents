import { twMerge } from "tailwind-merge";

/**
 * Joins class names, skipping falsy values, and resolves Tailwind conflicts so the last one wins:
 * `cn("w-full", className)` with `className="w-28"` gives `w-28`.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}
