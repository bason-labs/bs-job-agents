// Data-access seam for the web app (spec §4.2, §11). Screens never fetch on their own:
// - Client components: useApi(), useResource(), useAppEvents(), useFeedStatus() from "@/lib/api/react".
// - Server components: `api.*` below (shell lookups) or `getServerApi()` from "@/lib/api/server".
// - Contract and types: WebApi (contract.ts), view models (types.ts), mappers (map.ts).
// Live mode talks to the orchestrator (HTTP through /api/orch + SSE); mock mode uses the
// in-memory backend in mock/ (BSJA_API_MODE, see config.ts).
import { isApiError } from "./errors";
import { offlineShellData } from "./map";
import { getServerApi } from "./server";
import type { BotSummary, RoomSummary, ShellData } from "./types";

export type * from "./types";
export type {
  AnswerInput,
  ApiMode,
  ApproveInput,
  ApproveResult,
  EventFeed,
  FeedStatus,
  HealthState,
  MessagesPage,
  SendMessageInput,
  ProgressLine,
  WebApi,
} from "./contract";
export { ApiRequestError, errorMessage, isApiError } from "./errors";

function serverOnly(name: string) {
  if (typeof window !== "undefined") throw new Error(`api.${name} is server-only; client components use useApi() from "@/lib/api/react"`);
}

/** Server-side lookups (layouts, route params, metadata). They survive an unreachable orchestrator. */
export const api = {
  async getShellData(): Promise<ShellData> {
    serverOnly("getShellData");
    return (await getServerApi()).getShellData();
  },
  async getBot(name: string): Promise<BotSummary | null> {
    serverOnly("getBot");
    try {
      return await (await getServerApi()).getBot(name);
    } catch (err) {
      if (isApiError(err) && err.code === "unreachable") return offlineShellData().bots.find((b) => b.name === name) ?? null;
      throw err;
    }
  },
  async getRoom(id: string): Promise<RoomSummary | null> {
    serverOnly("getRoom");
    try {
      return await (await getServerApi()).getRoom(id);
    } catch (err) {
      if (isApiError(err) && err.code === "unreachable") return null;
      throw err;
    }
  },
};
