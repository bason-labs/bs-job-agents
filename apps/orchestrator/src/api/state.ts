// Small UI decisions the API keeps that have no table (W3a): a dismissed promotion suggestion
// (UC-19) and a fact request Ba answered "No, I don't" (§6.1). data/api-state.json, written through
// a temp file and a rename; one orchestrator holds the data folder, so there is one writer.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const API_STATE_FILE = "api-state.json";

const StateSchema = z.object({
  /** Per bot: the streak count when Ba dismissed the suggestion, and when. */
  promotionDismissals: z.record(z.object({ count: z.number().int().nonnegative(), at: z.string() })).default({}),
  /** Fact request ids (`<cvVersionId>-<index>`) Ba answered "No". */
  dismissedFactRequests: z.array(z.string()).default([]),
});
export type ApiState = z.infer<typeof StateSchema>;

export function readApiState(dataDir: string): ApiState {
  const path = join(dataDir, API_STATE_FILE);
  if (!existsSync(path)) return StateSchema.parse({});
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : StateSchema.parse({});
  } catch {
    return StateSchema.parse({});
  }
}

export function updateApiState(dataDir: string, change: (state: ApiState) => ApiState): ApiState {
  const next = change(readApiState(dataDir));
  const path = join(dataDir, API_STATE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}
