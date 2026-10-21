// Live 2026-10-20: with two Claude in Chrome extensions connected, a bot cannot act until a browser
// is selected, and the site guard never lets the model choose one. Ba picks the browser bots use
// (Bots screen, "Chrome browser for bots"); its deviceId is the only one select_browser may name.
// The browsers listed are the ones the bots' Chrome tools reported (the orchestrator has no Chrome
// connection of its own). Never a credential.
import { z } from "zod";
import { IsoDateTimeSchema } from "../common/primitives.js";

export const ChromeBrowserSchema = z.object({
  deviceId: z.string().min(1),
  /** As the extension names it (e.g. the computer's name); null when the tool gave none. */
  name: z.string().nullable(),
  os: z.string().nullable(),
  isLocal: z.boolean().nullable(),
});
export type ChromeBrowser = z.infer<typeof ChromeBrowserSchema>;

export const ChromeBrowserViewSchema = z.object({
  /** The browser bots select, or null (none chosen yet). */
  preferred: ChromeBrowserSchema.nullable(),
  /** Browsers the bots' Chrome tools reported, newest report first; the preferred one included. */
  seen: z.array(ChromeBrowserSchema.extend({ seenAt: IsoDateTimeSchema })),
});
export type ChromeBrowserView = z.infer<typeof ChromeBrowserViewSchema>;

/** PUT: one of the seen browsers' deviceId, or null to clear the choice. */
export const ChromeBrowserUpdateSchema = z.object({ deviceId: z.string().min(1).nullable() });
export type ChromeBrowserUpdate = z.infer<typeof ChromeBrowserUpdateSchema>;
