// Search criteria in the mock orchestrator (UC-21b): like the orchestrator's updateSearchProfile,
// every save adds a version row and makes it the active one; runs keep the version they started with.
import type { SearchProfile, SearchProfileFields } from "@bs-job-agents/shared";
import type { MockBackend } from "./backend";

export function activeProfile(core: MockBackend): SearchProfile | null {
  return core.state.profiles.find((p) => p.active) ?? null;
}

/** Saves `fields` as the next version of the active profile (or creates "Default" v1). */
export function saveCriteria(core: MockBackend, fields: SearchProfileFields): SearchProfile {
  const active = activeProfile(core);
  const name = active?.name ?? "Default";
  const version = Math.max(0, ...core.state.profiles.filter((p) => p.name === name).map((p) => p.version)) + 1;
  const { id: _id, name: _name, version: _version, active: _active, updatedAt: _updatedAt, ...plain } = fields as SearchProfileFields & Partial<SearchProfile>;
  const row: SearchProfile = { ...plain, id: core.nextId(), name, version, active: true, updatedAt: core.nowIso() };
  for (const p of core.state.profiles) p.active = false;
  core.state.profiles.push(row);
  core.state.criteriaVersion = version;
  return row;
}
