// Data-access seam for the web app. Pages and layouts call `api.*` only.
// Phase 3 (W3a/W3b/W3c): replace `mockApi` with an implementation that calls
// the orchestrator (HTTP + SSE, spec §4.2/§11 live updates) and keep this
// interface stable so screens don't change.
import { MOCK_SHELL_DATA } from "@/lib/mock/shell";
import type { BotSummary, RoomSummary, ShellData } from "./types";

export type * from "./types";

export interface WebApi {
  /** Everything the sidebar + top bar need (bots, rooms, usage, review count). */
  getShellData(): Promise<ShellData>;
  getBot(name: string): Promise<BotSummary | null>;
  getRoom(id: string): Promise<RoomSummary | null>;
}

const mockApi: WebApi = {
  async getShellData() {
    return structuredClone(MOCK_SHELL_DATA);
  },
  async getBot(name) {
    return MOCK_SHELL_DATA.bots.find((b) => b.name === name) ?? null;
  },
  async getRoom(id) {
    return MOCK_SHELL_DATA.rooms.find((r) => r.id === id) ?? null;
  },
};

export const api: WebApi = mockApi;
