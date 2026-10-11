// Fake sidebar data so the shell renders before the orchestrator API exists
// (Phase 3 replaces lib/api's mock implementation). Mirrors the prototype.
import type { BotSummary, ShellData } from "@/lib/api/types";

export const MOCK_BOTS: BotSummary[] = [
  { name: "lead", displayName: "Lead", engine: "claude", trustLevel: 1, status: "idle", role: "Receives every request; only divides work." },
  { name: "research", displayName: "Research", engine: "claude", trustLevel: 2, status: "working", role: "Finds jobs, scores fit, profiles companies (read-only browser)." },
  { name: "cv", displayName: "CV", engine: "claude", trustLevel: 2, status: "idle", role: "Tailors CV in Figma from master facts; never invents." },
  { name: "qa", displayName: "QA", engine: "codex", trustLevel: 2, status: "idle", role: "Scores CV vs JD + company; hard-fails invented facts." },
  { name: "apply", displayName: "Apply", engine: "claude", trustLevel: 1, status: "idle", role: "Fills & submits forms in your Chrome after your approval." },
];

export const MOCK_SHELL_DATA: ShellData = {
  bots: MOCK_BOTS,
  rooms: [{ id: "cv-brainstorm", name: "cv-brainstorm" }],
  usage: [
    { engine: "claude", label: "Claude", utilization: 0.42, pausedUntil: null },
    { engine: "codex", label: "ChatGPT", utilization: 0.18, pausedUntil: null },
  ],
  reviewCount: 3,
  activeRunId: "12",
  chromeConnected: true,
};
